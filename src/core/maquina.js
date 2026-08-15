// Máquina de estados de la conversación con la clienta.
// El estado vive en la DB (clientas.estado_conv + datos_conv), así sobrevive
// reinicios del bot. Cada manejador devuelve mensajes salientes.
//
//  inicio ─► eligiendo_servicio ─► eligiendo_dia ─► eligiendo_hora
//    │                                                   │
//    ├─► cancelando                     (sin nombre) pidiendo_nombre
//    │                                                   │
//    └─► (FAQ responde y queda en inicio)           confirmando
//                                              ┌─────────┴─────────┐
//                                    (con seña) esperando_comprobante   (sin seña) confirmado
//
const qClientas = require('../db/consultas/clientas');
const qServicios = require('../db/consultas/servicios');
const qTurnos = require('../db/consultas/turnos');
const qSenas = require('../db/consultas/senas');
const agenda = require('./agenda');
const fechas = require('./fechas');
const senasFlujo = require('./flujos/senas');
const faq = require('./flujos/faq');
const nlu = require('./nlu');
const notif = require('./notificaciones');

const HORAS_DERIVACION = 12;

// Números sueltos dentro del texto: "el 2 porfa" → [2], "1 y 3" → [1, 3]
function numerosDe(texto) {
  return (texto.match(/\d+/g) || []).map(Number);
}

// Escape global: desde cualquier punto de la conversación se vuelve al menú.
const VOLVER_AL_MENU = [
  'menu', 'menú', 'inicio', 'volver', 'volver al menu', 'volver al menú',
  'volver al inicio', 'ir al menu', 'ir al menú', 'menu principal', 'menú principal',
  'empezar de nuevo', 'empezar de cero', 'de nuevo', 'atras', 'atrás', 'salir',
];

// Cierres de cortesía: no merecen el menú completo de vuelta.
const CORTESIA = [
  'gracias', 'muchas gracias', 'mil gracias', 'genial', 'perfecto', 'dale',
  'listo', 'buenisimo', 'buenísimo', 'ok', 'oka', 'okey', 'joya', 'barbaro',
  'bárbaro', 'nos vemos', 'besos', 'de nada', 'igualmente', '👍', '❤️', '🙌', '😊', '💅',
];

// ---------- entrada principal ----------
// msj: { texto, rutaImagen?, productoId? }  →  devuelve [{para, texto, ...}]
function procesar(config, clienta, msj) {
  const texto = (msj.texto || '').trim();
  // datos_conv corrupto (edición a mano, corte de luz a mitad de escritura):
  // arrancamos de cero en vez de tumbar el bot.
  let datos = {};
  try { datos = JSON.parse(clienta.datos_conv || '{}') || {}; } catch {
    console.error(`datos_conv inválido en clienta ${clienta.id}, reiniciando su estado`);
    clienta.estado_conv = 'inicio';
  }
  const ctx = { config, clienta, datos, msj, texto: texto.toLowerCase() };

  // Tocaron un ítem del catálogo de WhatsApp Business → arranca directo ahí.
  if (msj.productoId) {
    const servicio = qServicios.porCatalogoId(msj.productoId);
    if (servicio) return elegirServicio(ctx, servicio);
    // Ítem sin mapear en la DB (catalogo_id vacío o viejo): ofrecemos la lista
    // igual — la clienta ya mostró que quiere reservar.
    ctx.datos = {};
    return responder(ctx, 'eligiendo_servicio',
      `¡Buenísimo! ¿Qué servicio querés?\n\n${listaServicios(ctx.config)}\n\nRespondé con el número (o *menú* para volver al principio).`);
  }

  // "menú" / "volver" / "empezar de nuevo" funcionan en cualquier estado.
  if (VOLVER_AL_MENU.includes(ctx.texto.replace(/[!.,¿?]/g, '').trim())) {
    // Excepción: si está esperando el comprobante hay un turno reservado
    // ocupando un horario. No la sacamos del flujo sin avisarle.
    if (clienta.estado_conv === 'esperando_comprobante') {
      return [{
        para: clienta.telefono,
        texto: `Tenés una reserva esperando la seña ⏳\nSi ya transferiste, mandame la *foto del comprobante*.\nSi te arrepentiste, escribí *0* y libero el horario.`,
      }];
    }
    ctx.datos = {};
    return menu(ctx, '¡Volvamos al principio!');
  }

  const manejadores = {
    inicio, cancelando, eligiendo_servicio, eligiendo_dia,
    eligiendo_hora, pidiendo_nombre, confirmando, esperando_comprobante,
  };
  const manejador = manejadores[clienta.estado_conv] || inicio;
  return manejador(ctx);
}

// ---------- helpers ----------
function responder(ctx, estado, texto, extraSalientes) {
  qClientas.guardarEstado(ctx.clienta.id, estado, ctx.datos);
  qClientas.limpiarNoEntendidos(ctx.clienta.id);
  const salientes = [{ para: ctx.clienta.telefono, texto }];
  return extraSalientes ? salientes.concat(extraSalientes) : salientes;
}

// Entrada no reconocida: a la segunda seguida, deriva a humano.
function noEntendi(ctx, ayuda) {
  const n = qClientas.sumarNoEntendido(ctx.clienta.id);
  if (n >= 2) {
    qClientas.derivar(ctx.clienta.id, HORAS_DERIVACION);
    return [
      { para: ctx.clienta.telefono, texto: 'Disculpá, no te estoy entendiendo 😅 Ya le aviso a la dueña para que te responda personalmente en un ratito.' },
      notif.derivacion(ctx.config, ctx.clienta, ctx.msj.texto || '(sin texto)'),
    ];
  }
  return [{ para: ctx.clienta.telefono, texto: ayuda }];
}

function menu(ctx, saludo) {
  const encabezado = saludo ? `${saludo}\n\n` : '';
  return responder(ctx, 'inicio',
    `${encabezado}¿Qué necesitás?\n\n*1* — Reservar un turno 💅\n*2* — Ver precios\n*3* — Ubicación y horarios\n*4* — Hablar con una persona\n\nRespondé con el número.`);
}

function listaServicios(config) {
  return qServicios.activos().map(
    (s) => `*${s.id}* — ${s.nombre} (${s.duracion_min} min) $${s.precio}${s.sena ? ` — seña $${s.sena}` : ''}`
  ).join('\n');
}

// ---------- estados ----------
function inicio(ctx) {
  const t = ctx.texto;

  // Sin texto (sticker, audio, foto suelta): silencio, nada de menú.
  if (!t) return [];

  // "gracias", "genial", un emoji: respuesta corta y listo.
  const tLimpio = t.replace(/[!.,~\s]+$/g, '');
  if (CORTESIA.includes(tLimpio)) {
    return responder(ctx, 'inicio', '¡Gracias a vos! 😊 Cualquier cosa escribime *hola* y te ayudo.');
  }

  // FAQ por palabras clave (no cuenta como "no entendido")
  const respuestaFaq = faq.buscar(ctx.config, t, listaServicios(ctx.config));
  if (respuestaFaq) return responder(ctx, 'inicio', respuestaFaq);

  // Opciones numéricas del menú
  if (t === '1') {
    ctx.datos = {};
    return responder(ctx, 'eligiendo_servicio',
      `¡Buenísimo! ¿Qué servicio querés?\n\n${listaServicios(ctx.config)}\n\nRespondé con el número (o *menú* para volver al principio).`);
  }
  if (t === '2') return responder(ctx, 'inicio', faq.precios(listaServicios(ctx.config)));
  if (t === '3') return responder(ctx, 'inicio', faq.ubicacionYHorarios(ctx.config));
  if (t === '4') return derivarAHumano(ctx, '(pidió hablar con una persona)');

  // Lenguaje natural: diccionario de intenciones + typos (ver nlu.js)
  const inter = nlu.interpretar(t, qServicios.activos());

  if (inter.intencion === 'confirmar') {
    const turno = qTurnos.proximoDeClienta(ctx.clienta.id, fechas.aTexto(fechas.ahora()));
    if (turno) {
      qTurnos.guardarRespuestaRecordatorio(turno.id, 'confirmo');
      return responder(ctx, 'inicio', `¡Gracias por confirmar! Te esperamos el ${fechas.diaLindo(turno.inicio.slice(0, 10))} a las ${turno.inicio.slice(11)} 💅`);
    }
  }
  if (inter.intencion === 'cancelar') {
    const turno = qTurnos.proximoDeClienta(ctx.clienta.id, fechas.aTexto(fechas.ahora()));
    if (!turno) return responder(ctx, 'inicio', 'No encontré ningún turno tuyo para cancelar. Escribí *hola* si querés reservar uno.');
    ctx.datos.turnoCancelar = turno.id;
    return responder(ctx, 'cancelando',
      `¿Cancelo tu turno del ${fechas.diaLindo(turno.inicio.slice(0, 10))} a las ${turno.inicio.slice(11)} (${turno.servicio})?\n\n*1* — Sí, cancelar\n*2* — No, lo mantengo`);
  }
  if (inter.intencion === 'humano') return derivarAHumano(ctx, ctx.msj.texto);

  // "quiero kapping mañana a las 15" → salta todos los pasos que ya vinieron
  const fh = nlu.extraerFechaHora(t);
  if (inter.servicio) return elegirServicio(ctx, inter.servicio, fh);

  // Mencionar un día u hora ya es querer un turno, aunque no diga "reservar"
  // ("se puede el sábado 10 hs?", "tenés algo mañana a la tarde?")
  if (inter.intencion === 'reservar' || fh.dia || fh.hora) {
    // "quería reservar para el viernes a las 10" sin decir el servicio:
    // guardamos día/hora y los usamos apenas elija el servicio.
    ctx.datos = { fh };
    return responder(ctx, 'eligiendo_servicio',
      `¡Buenísimo! ¿Qué servicio querés?\n\n${listaServicios(ctx.config)}\n\nRespondé con el número (o *menú* para volver al principio).`);
  }

  // Saludo o cualquier otra cosa → menú de bienvenida
  return menu(ctx, `¡Hola! 👋 Soy el asistente de *${ctx.config.negocio.nombre}*.`);
}

function derivarAHumano(ctx, textoCitado) {
  qClientas.derivar(ctx.clienta.id, HORAS_DERIVACION);
  return [
    { para: ctx.clienta.telefono, texto: 'Dale, le aviso a la dueña y te responde personalmente en un ratito 🙌' },
    notif.derivacion(ctx.config, ctx.clienta, textoCitado || '(sin texto)'),
  ];
}

function cancelando(ctx) {
  if (ctx.texto === '1') {
    const turno = qTurnos.porId(ctx.datos.turnoCancelar);
    qTurnos.cambiarEstado(turno.id, 'cancelado');
    ctx.datos = {};
    return responder(ctx, 'inicio',
      'Listo, tu turno quedó cancelado. ¡Gracias por avisar! Cuando quieras otro, escribí *hola* 😊',
      [notif.cancelacion(ctx.config, turno, 'canceló la clienta')]);
  }
  if (ctx.texto === '2') {
    ctx.datos = {};
    return responder(ctx, 'inicio', '¡Perfecto, tu turno sigue en pie! Te esperamos 💅');
  }
  return noEntendi(ctx, 'Respondé *1* para cancelar o *2* para mantener el turno.');
}

function eligiendo_servicio(ctx) {
  // Primero por nombre, porque puede venir con fecha y hora incluidas
  // ("kapping el 14/8 a las 10") y esos números NO son una selección múltiple.
  const porNombre = nlu.servicioPorNombre(ctx.texto, qServicios.activos());
  if (porNombre && porNombre.activo) {
    return elegirServicio(ctx, porNombre, nlu.extraerFechaHora(ctx.msj.texto || ''));
  }
  const nums = numerosDe(ctx.texto);
  if (nums.length > 1) {
    return responder(ctx, 'eligiendo_servicio',
      'De a uno 😅 Puedo agendar *un servicio por turno*: elegí un solo número, y cuando terminemos sacás otro turno si querés.');
  }
  const servicio = qServicios.porId(nums[0] ?? -1);
  if (!servicio || !servicio.activo) {
    return noEntendi(ctx, `No encontré ese servicio 🤔 Elegí un número de la lista:\n\n${listaServicios(ctx.config)}`);
  }
  return elegirServicio(ctx, servicio, nlu.extraerFechaHora(ctx.msj.texto || ''));
}

// Compartido entre elección por número, por nombre y por catálogo.
// fh = { dia, hora } sacados del texto libre ("mañana a las 15"): lo que ya
// vino resuelto se saltea. Si faltó algo, se completa con lo que la clienta
// haya dicho antes en el mismo flujo (ctx.datos.fh).
function elegirServicio(ctx, servicio, fh) {
  const previo = ctx.datos.fh || {};
  fh = { dia: (fh && fh.dia) || previo.dia || null, hora: (fh && fh.hora) || previo.hora || null };
  ctx.datos = { servicioId: servicio.id };

  const dias = agenda.diasDisponibles(ctx.config, servicio);
  if (!dias.length) {
    return responder(ctx, 'inicio', 'Uy, no tengo horarios libres en los próximos días 😔 Escribí *4* si querés coordinar directo con la dueña.');
  }
  ctx.datos.dias = dias;
  const listaDias = dias.map((d, i) => `*${i + 1}* — ${fechas.diaLindo(d)}`).join('\n');

  if (fh.dia) {
    // ¿Pidió una fecha más allá de lo que agendamos?
    const limite = new Date(Date.now() + ctx.config.turnos.dias_hacia_adelante * 86400000);
    if (fh.dia > fechas.aTexto(limite).slice(0, 10)) {
      return responder(ctx, 'eligiendo_dia',
        `Por ahora agendo hasta ${ctx.config.turnos.dias_hacia_adelante} días para adelante 😅 Estos días puedo:\n\n${listaDias}\n\nRespondé con el número, *0* para volver o *menú* para empezar de nuevo.`);
    }
    const horas = agenda.horariosLibres(ctx.config, servicio, fh.dia);
    if (!horas.length) {
      return responder(ctx, 'eligiendo_dia',
        `Uy, el ${fechas.diaLindo(fh.dia)} no tengo lugar para *${servicio.nombre}* 😕 Estos días sí puedo:\n\n${listaDias}\n\nRespondé con el número, *0* para volver o *menú* para empezar de nuevo.`);
    }
    ctx.datos.dia = fh.dia;
    ctx.datos.horas = horas;
    const listaHoras = horas.map((h, j) => `*${j + 1}* — ${h}`).join('\n');

    if (fh.hora && horas.includes(fh.hora)) {
      // Vino todo: servicio + día + hora → derecho al nombre o la confirmación
      ctx.datos.hora = fh.hora;
      if (!ctx.clienta.nombre) {
        return responder(ctx, 'pidiendo_nombre',
          `¡De una! *${servicio.nombre}* el ${fechas.diaLindo(fh.dia)} a las ${fh.hora} 👌\n¿Me decís tu nombre para agendar?`);
      }
      return resumenParaConfirmar(ctx);
    }
    if (fh.hora) {
      return responder(ctx, 'eligiendo_hora',
        `Uy, a las ${fh.hora} no tengo lugar el ${fechas.diaLindo(fh.dia)} 😕 Ese día puedo:\n\n${listaHoras}\n\nRespondé con el número, *0* para volver o *menú* para empezar de nuevo.`);
    }
    return responder(ctx, 'eligiendo_hora',
      `*${servicio.nombre}* el ${fechas.diaLindo(fh.dia)} 👌 Horarios libres:\n\n${listaHoras}\n\nRespondé con el número, *0* para volver o *menú* para empezar de nuevo.`);
  }

  return responder(ctx, 'eligiendo_dia',
    `*${servicio.nombre}* ($${servicio.precio}) 👌\n¿Qué día te queda bien?\n\n${listaDias}\n\nRespondé con el número, *0* para volver o *menú* para empezar de nuevo.`);
}

function eligiendo_dia(ctx) {
  if (ctx.texto === '0') { ctx.datos = {}; return menu(ctx); }
  const dias = ctx.datos.dias || [];
  // ¿Escribió la fecha directa? "14/8" → buscarla en la lista
  const f = ctx.texto.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (f) {
    const buscada = dias.find((d) => {
      const [, m, dd] = d.split('-').map(Number);
      return dd === Number(f[1]) && m === Number(f[2]);
    });
    if (buscada) { ctx.datos.dia = buscada; return pedirHorarios(ctx, buscada); }
  }
  const nums = numerosDe(ctx.texto);
  if (nums.length > 1) {
    return responder(ctx, 'eligiendo_dia', 'Elegí *un solo día* (un número de la lista) 😊');
  }
  const i = (nums[0] ?? 0) - 1;
  const dia = i >= 0 ? dias[i] : null;
  if (!dia) return noEntendi(ctx, 'Elegí un número de la lista de días, o *0* para volver.');
  return pedirHorarios(ctx, dia);
}

function pedirHorarios(ctx, dia) {
  const servicio = qServicios.porId(ctx.datos.servicioId);
  const horas = agenda.horariosLibres(ctx.config, servicio, dia);
  if (!horas.length) return noEntendi(ctx, 'Ese día se acaba de llenar 😅 Elegí otro de la lista.');

  ctx.datos.dia = dia;
  ctx.datos.horas = horas;
  const lista = horas.map((h, j) => `*${j + 1}* — ${h}`).join('\n');
  return responder(ctx, 'eligiendo_hora',
    `${fechas.diaLindo(dia)} — horarios libres:\n\n${lista}\n\nRespondé con el número, *0* para volver o *menú* para empezar de nuevo.`);
}

function eligiendo_hora(ctx) {
  if (ctx.texto === '0') { ctx.datos = {}; return menu(ctx); }
  const horas = ctx.datos.horas || [];
  // ¿Escribió la hora directa? "10:30" o "10.30" → buscarla en la lista
  const hLit = ctx.texto.match(/^(\d{1,2})[:.](\d{2})$/);
  let hora = hLit ? horas.find((h) => h === `${hLit[1].padStart(2, '0')}:${hLit[2]}`) : null;
  if (!hora) {
    const nums = numerosDe(ctx.texto);
    if (nums.length > 1) {
      return responder(ctx, 'eligiendo_hora', 'Elegí *un solo horario* (un número de la lista) 😊');
    }
    const j = (nums[0] ?? 0) - 1;
    hora = j >= 0 ? horas[j] : null;
  }
  if (!hora) return noEntendi(ctx, 'Elegí un número de la lista de horarios, o *0* para volver.');

  ctx.datos.hora = hora;
  if (!ctx.clienta.nombre) {
    return responder(ctx, 'pidiendo_nombre', '¿Me decís tu nombre para agendar el turno? 😊\n(o *menú* para volver al principio)');
  }
  return resumenParaConfirmar(ctx);
}

function pidiendo_nombre(ctx) {
  const nombre = (ctx.msj.texto || '').trim();
  // Si parece una pregunta u otra intención ("cuánto sale?", "cancelar"),
  // no es un nombre: repreguntamos en vez de agendar cualquier cosa.
  const pareceOtraCosa = nombre.includes('?') || nombre.includes('¿')
    || nlu.interpretar(nombre).intencion;
  // Tiene que tener al menos 2 letras de verdad: "💅✨", "M" o "123" no son nombres.
  if (nombre === '0') {
    ctx.datos = {};
    return responder(ctx, 'inicio', 'Listo, no reservé nada. Cuando quieras escribí *hola* 😊');
  }
  const letras = (nombre.match(/[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ]/g) || []).length;
  if (pareceOtraCosa || letras < 2 || nombre.length > 40) {
    // Repreguntamos sin contar hacia la derivación: equivocarse escribiendo el
    // nombre es común y no significa que el bot no la esté entendiendo.
    return responder(ctx, 'pidiendo_nombre',
      'Necesito tu nombre para agendar el turno 😊 (o escribí *0* si preferís cancelar)');
  }
  qClientas.guardarNombre(ctx.clienta.id, nombre);
  ctx.clienta.nombre = nombre;
  return resumenParaConfirmar(ctx);
}

function resumenParaConfirmar(ctx) {
  const s = qServicios.porId(ctx.datos.servicioId);
  const senaTxt = (ctx.config.senas.habilitadas && s.sena > 0)
    ? `\n💸 Seña para reservar: $${s.sena}` : '';
  return responder(ctx, 'confirmando',
    `Perfecto ${ctx.clienta.nombre}, repasemos:\n\n💅 ${s.nombre}\n📅 ${fechas.diaLindo(ctx.datos.dia)} a las ${ctx.datos.hora}\n💰 $${s.precio}${senaTxt}\n\n*1* — Confirmar\n*2* — Cambiar\n*0* — Cancelar`);
}

function confirmando(ctx) {
  if (ctx.texto === '2') { ctx.datos = {}; return responder(ctx, 'eligiendo_servicio', `Dale, arranquemos de nuevo. ¿Qué servicio querés?\n\n${listaServicios(ctx.config)}`); }
  if (ctx.texto === '0') { ctx.datos = {}; return responder(ctx, 'inicio', 'Listo, no reservé nada. Cuando quieras escribí *hola* 😊'); }
  if (ctx.texto !== '1') return noEntendi(ctx, 'Respondé *1* para confirmar, *2* para cambiar o *0* para cancelar.');

  const s = qServicios.porId(ctx.datos.servicioId);
  const inicioT = `${ctx.datos.dia} ${ctx.datos.hora}`;
  const finT = fechas.sumarMinutos(inicioT, s.duracion_min);

  // Chequeo final anti carrera: pudo reservarlo otra clienta mientras charlaban.
  if (qTurnos.haySolapamiento(inicioT, finT)) {
    ctx.datos = { servicioId: s.id };
    return responder(ctx, 'eligiendo_servicio', 'Uy, justo ese horario lo acaban de reservar 😔 Empecemos de nuevo: ¿qué servicio querés?\n\n' + listaServicios(ctx.config));
  }

  const conSena = ctx.config.senas.habilitadas && s.sena > 0;
  const turnoId = qTurnos.crear(ctx.clienta.id, s.id, inicioT, finT, conSena ? 'pendiente_sena' : 'confirmado');

  if (!conSena) {
    ctx.datos = {};
    const turno = qTurnos.porId(turnoId);
    return responder(ctx, 'inicio',
      `¡Turno confirmado! 🎉\n📅 ${fechas.diaLindo(ctx.datos.dia || turno.inicio.slice(0, 10))} a las ${turno.inicio.slice(11)}\n💅 ${s.nombre}\n\nTe mandamos un recordatorio un día antes. ¡Te esperamos!`,
      [notif.turnoConfirmado(ctx.config, turno),
       ...notif.invitacionCalendario(ctx.config, turno),
       ...notif.tarjetaContacto(ctx.config, ctx.clienta, turno)]);
  }

  const venceEn = fechas.aTexto(new Date(Date.now() + ctx.config.senas.vencimiento_horas * 3600000));
  qSenas.crear(turnoId, s.sena, venceEn);
  ctx.datos = { turnoId };
  return responder(ctx, 'esperando_comprobante',
    `¡Casi listo! Para reservar te pido una seña de *$${s.sena}* por transferencia:\n\n🏦 Alias: *${ctx.config.senas.alias_mp}*\n👤 Titular: ${ctx.config.senas.titular}\n\nCuando la hagas, mandame la *foto del comprobante* por acá. Tenés ${ctx.config.senas.vencimiento_horas} hs, después el horario se libera solo 😉`);
}

function esperando_comprobante(ctx) {
  if (!ctx.msj.rutaImagen) {
    if (ctx.texto === '0' || ctx.texto === 'cancelar') {
      const turno = qTurnos.porId(ctx.datos.turnoId);
      qTurnos.cambiarEstado(turno.id, 'cancelado');
      const sena = qSenas.porTurno(turno.id);
      if (sena) qSenas.cambiarEstado(sena.id, 'vencido', 'clienta');
      ctx.datos = {};
      return responder(ctx, 'inicio', 'Listo, cancelé la reserva y el horario quedó libre. Cuando quieras escribí *hola* 😊',
        [notif.cancelacion(ctx.config, turno, 'canceló la clienta antes de señar')]);
    }
    return responder(ctx, 'esperando_comprobante',
      `Te espero con la *foto del comprobante* 📸 (alias: *${ctx.config.senas.alias_mp}*).\nSi te arrepentiste, escribí *0* y libero el horario.`);
  }

  const r = senasFlujo.procesarComprobante(ctx.config, ctx.clienta, ctx.datos.turnoId, ctx.msj);
  ctx.datos = {};
  qClientas.guardarEstado(ctx.clienta.id, 'inicio', ctx.datos);
  qClientas.limpiarNoEntendidos(ctx.clienta.id);
  return r.salientes;
}

module.exports = { procesar };
