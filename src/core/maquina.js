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
const qNoEntendidos = require('../db/consultas/noEntendidos');
const agenda = require('./agenda');
const fechas = require('./fechas');
const senasFlujo = require('./flujos/senas');
const faq = require('./flujos/faq');
const nlu = require('./nlu');
const rubros = require('./diccionario/rubros');
const notif = require('./notificaciones');
const { aQuienAtiende } = require('../plantillas');


// Números sueltos dentro del texto: "el 2 porfa" → [2], "1 y 3" → [1, 3]
function numerosDe(texto) {
  return (texto.match(/\d+/g) || []).map(Number);
}

// Preguntas de precio: "cuánto sale el kapping", "precio del semi", "a cuánto el corte con barba".
const PIDE_PRECIO = ['precio', 'precios', 'cuanto', 'sale', 'salen', 'cuesta', 'cuestan', 'vale', 'valen', 'valor', 'cobras',
  'cobran', 'tarifa', 'tarifas', 'lista de precios'];

// Los sinónimos de servicios del rubro (diccionario/rubros.js): "manicura" → semipermanente manos.
const sinonimos = (ctx) => rubros.serviciosDe(ctx.config.negocio.rubro);

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
  const ctx = { config, clienta, datos, msj, texto: texto.toLowerCase(), entender: entenderEnPaso };

  // Tocaron un ítem del catálogo de WhatsApp Business → arranca directo ahí.
  if (msj.productoId) {
    const servicio = qServicios.porCatalogoId(msj.productoId);
    if (servicio) return elegirServicio(ctx, servicio);
    // Ítem sin mapear en la DB (catalogo_id vacío o viejo): ofrecemos la lista
    // igual — la clienta ya mostró que quiere reservar.
    ctx.datos = {};
    return preguntarServicio(ctx);
  }

  // "menú" / "volver" / "empezar de nuevo" funcionan en cualquier estado.
  if (nlu.esVolverAlMenu(texto)) {
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

// Queda anotado para mejorar el diccionario (la dueña lo ve con "qué no entendiste").
function anotarNoEntendido(ctx) {
  try { qNoEntendidos.registrar(ctx.clienta.telefono, ctx.msj.texto, ctx.clienta.estado_conv); } catch (e) {
    console.error('No pude anotar un mensaje no entendido:', e.message);
  }
}

// Entrada no reconocida: a la segunda seguida, deriva a humano. Antes, si la conversación está a mitad de un paso
// (eligiendo el día, confirmando, armando un pedido), prueba entenderlo como si estuviera en el menú: la gente cambia de
// tema ("gracias genia!", "¿cuánto sale el kapping?", "¿hacen envíos?") y eso no es no entender. `ctx.entender` lo pone
// cada conversación (turnos acá, comercio en comercio.js).
function noEntendi(ctx, ayuda) {
  if (ctx.entender && !ctx.yaProbo) {
    ctx.yaProbo = true;
    const r = ctx.entender(ctx, ayuda);
    if (r) return r;
  }
  anotarNoEntendido(ctx);
  const n = qClientas.sumarNoEntendido(ctx.clienta.id);
  if (n >= 2) {
    qClientas.derivar(ctx.clienta.id, ctx.config.pausa_minutos);
    return [
      { para: ctx.clienta.telefono, texto: `Disculpá, no te estoy entendiendo 😅 Ya le aviso ${aQuienAtiende(ctx.config.textos)} para que te responda personalmente en un ratito.` },
      notif.derivacion(ctx.config, ctx.clienta, ctx.msj.texto || '(sin texto)'),
    ];
  }
  return [{ para: ctx.clienta.telefono, texto: ayuda }];
}

function menu(ctx, saludo) {
  const encabezado = saludo ? `${saludo}\n\n` : '';
  ctx.datos.menuVisto = Date.now();
  return responder(ctx, 'inicio',
    `${encabezado}¿Qué necesitás?\n\n*1* — Reservar un turno ${ctx.config.textos.emoji}\n*2* — Ver precios\n*3* — Ubicación y horarios\n*4* — Hablar con una persona\n\nRespondé con el número.`);
}

// Un negocio que todavía no cargó servicios (recién instalado en Nodo Sur Servicios) no ofrece los de ejemplo: pasa la charla a
// una persona (El dueño, 2026-10-10: aparecían los servicios de demo de uñas). Null si hay servicios.
function sinServicios(ctx) {
  if (qServicios.activos().length) return null;
  ctx.datos = {};
  return derivarAHumano(ctx, '(quiere un turno o precios, pero todavía no hay servicios cargados en la app)',
    'Todavía estamos cargando los servicios por acá 🙏 Le aviso a quien atiende y te responde personalmente en un ratito.');
}

function preguntarServicio(ctx) {
  return sinServicios(ctx) || responder(ctx, 'eligiendo_servicio',
    `¡Buenísimo! ¿Qué servicio querés?\n\n${listaServicios(ctx.config)}\n\nRespondé con el número (o *menú* para volver al principio).`);
}

function listaServicios(config, servicios = qServicios.activos()) {
  return servicios.map(
    (s) => `*${s.id}* — ${s.nombre} (${s.duracion_min} min) $${s.precio}${s.sena ? ` — seña $${s.sena}` : ''}`
  ).join('\n');
}

// Los temas de cualquier negocio (nlu.tema): cómo se paga, envíos, horarios, ubicación y las preguntas que cargó el
// negocio (`porDefecto` pone la respuesta de un rubro). Si el negocio no cargó la respuesta en config.respuestas, el bot
// le pasa la pregunta a la dueña y SIGUE atendiendo: por "¿aceptan tarjeta?" no se calla una hora en ese chat.
function responderTema(ctx, tm, porDefecto = {}, estado = 'inicio') {
  if (tm.tema === 'pregunta') return responder(ctx, estado, tm.respuesta);
  if (tm.tema === 'horarios' || tm.tema === 'ubicacion') return responder(ctx, estado, faq.ubicacionYHorarios(ctx.config));
  const respuesta = ctx.config.respuestas?.[tm.tema] || porDefecto[tm.tema];
  if (respuesta) return responder(ctx, estado, respuesta);
  return responder(ctx, estado, `Eso te lo confirma ${ctx.config.textos.quien_atiende} por acá en un ratito 🙌 Mientras, si querés otra cosa, escribime.`,
    [notif.pregunta(ctx.config, ctx.clienta, ctx.msj.texto)]);
}

const esPreguntaDePrecio = (ctx, t) => {
  const norm = nlu.normalizar(t);
  const tokens = norm.split(' ');
  return [...PIDE_PRECIO, ...(ctx.config.faq?.precios || []).map(nlu.normalizar)].some((k) => nlu.contiene(norm, tokens, k));
};

// ---------- estados ----------
function inicio(ctx) {
  let t = ctx.texto;
  // Lo que se ofreció en el mensaje anterior ("¿Querés reservarlo? Respondé sí"): vale solo para este mensaje.
  const ofrecido = ctx.datos.ofrecido;
  delete ctx.datos.ofrecido;

  // Cuántas veces seguidas no se entendió en el menú (vale hasta que entienda algo).
  const sinEntender = ctx.datos.sinEntender || 0;
  delete ctx.datos.sinEntender;

  // Sin texto (sticker, audio, foto suelta) o una risa: silencio, nada de menú.
  if (!t || nlu.esRisa(t)) return [];

  if (ofrecido && nlu.esSi(t)) {
    const s = qServicios.porId(ofrecido);
    if (s && s.activo) return elegirServicio(ctx, s);
  }

  const apurado = apuro(ctx);
  if (apurado) return apurado;

  // "gracias", "genial", un emoji: respuesta corta y listo.
  if (nlu.esCortesia(t)) {
    return responder(ctx, 'inicio', '¡Gracias a vos! 😊 Cualquier cosa escribime *hola* y te ayudo.');
  }

  // Opciones numéricas del menú, como las escriba ("1.", "el 1", "opción 2", "uno")
  const op = nlu.opcionMenu(t);
  if (op && op <= 4) t = String(op);
  if (t === '1') {
    ctx.datos = {};
    return preguntarServicio(ctx);
  }
  if (t === '2') return sinServicios(ctx) || responder(ctx, 'inicio', faq.precios(listaServicios(ctx.config)));
  if (t === '3') return responder(ctx, 'inicio', faq.ubicacionYHorarios(ctx.config));
  if (t === '4') return derivarAHumano(ctx, '(pidió hablar con una persona)');

  return entender(ctx) || enojo(ctx) || (() => {
    // Saludo → menú de bienvenida. Otra cosa: queda anotada, y si es la segunda seguida que no se entiende, mejor una
    // persona que mostrarle el menú otra vez a alguien que ya se está cansando.
    if (nlu.interpretar(t).intencion === 'saludo') return menu(ctx, `¡Hola! 👋 Soy el asistente de *${ctx.config.negocio.nombre}*.`);
    anotarNoEntendido(ctx);
    if (sinEntender >= 1) {
      return derivarAHumano(ctx, ctx.msj.texto, `Perdón, no te estoy entendiendo 😅 Ya le aviso ${aQuienAtiende(ctx.config.textos)} para que te responda personalmente.`);
    }
    ctx.datos.sinEntender = sinEntender + 1;
    return menu(ctx, `¡Hola! 👋 Soy el asistente de *${ctx.config.negocio.nombre}*.`);
  })();
}

// Lo que se entiende del texto libre (diccionario común y del rubro, ver nlu.js y diccionario/), desde el menú o a mitad
// de un paso (`paso`: { estado, ayuda }). Devuelve los mensajes, o null si no entendió nada.
function entender(ctx, paso = null) {
  const t = ctx.texto;
  const estado = paso ? paso.estado : 'inicio';
  const inter = nlu.interpretar(t, qServicios.activos(), sinonimos(ctx));
  const fh = nlu.extraerFechaHora(t);
  const quiereFecha = fh.dia || fh.hora || fh.franja || fh.desde;
  const proximo = () => qTurnos.proximoDeClienta(ctx.clienta.id, fechas.aTexto(fechas.ahora()));

  // Cambiar el turno. Sin turno, si igual nombró un servicio o una fecha ("mejor el kapping"), sigue como una reserva.
  if (inter.intencion === 'reprogramar') {
    const turno = proximo();
    if (turno) return reprogramar(ctx, turno);
    if (!inter.servicio && !inter.candidatos.length && !quiereFecha) {
      return responder(ctx, 'inicio', 'No encontré ningún turno tuyo para cambiar 🤔 Si querés sacar uno, escribí *1*.');
    }
  }
  if (inter.intencion === 'demora') {
    const turno = proximo();
    return responder(ctx, 'inicio', `¡Gracias por avisar! Ya le aviso ${aQuienAtiende(ctx.config.textos)} 🙌`,
      [notif.demora(ctx.config, ctx.clienta, turno, ctx.msj.texto)]);
  }
  if (inter.intencion === 'confirmar') {
    const turno = proximo();
    if (turno) {
      qTurnos.guardarRespuestaRecordatorio(turno.id, 'confirmo');
      return responder(ctx, 'inicio', `¡Gracias por confirmar! Te esperamos el ${fechas.diaLindo(turno.inicio.slice(0, 10))} a las ${turno.inicio.slice(11)} ${ctx.config.textos.emoji}`);
    }
  }
  if (inter.intencion === 'cancelar') {
    const turno = proximo();
    if (!turno && paso) { ctx.datos = {}; return responder(ctx, 'inicio', 'Listo, lo dejamos acá: no reservé nada. Cuando quieras escribí *hola* 😊'); }
    if (!turno) return responder(ctx, 'inicio', 'No encontré ningún turno tuyo para cancelar. Escribí *hola* si querés reservar uno.');
    ctx.datos.turnoCancelar = turno.id;
    return responder(ctx, 'cancelando',
      `¿Cancelo tu turno del ${fechas.diaLindo(turno.inicio.slice(0, 10))} a las ${turno.inicio.slice(11)} (${turno.servicio})?\n\n*1* — Sí, cancelar\n*2* — No, lo mantengo`);
  }
  if (inter.intencion === 'humano') return derivarAHumano(ctx, ctx.msj.texto);

  // Cómo se paga, horarios, ubicación, las preguntas del negocio. "¿A qué hora tenés turno?" no pregunta el horario del
  // local: es una reserva. "¿Cómo pago la seña?": el alias.
  const tm = nlu.tema(ctx.config, t);
  const senas = ctx.config.senas || {};
  if (tm && tm.tema === 'pagos' && senas.habilitadas && /\bsena\b/.test(nlu.normalizar(t))) {
    return seguirEnPaso(ctx, paso, responder(ctx, estado, `La seña se paga por transferencia 🏦\nAlias: *${senas.alias_mp}*\nTitular: ${senas.titular}\n\nDespués me mandás la foto del comprobante por acá.`));
  }
  if (tm && !(tm.tema === 'horarios' && inter.intencion === 'reservar')) return seguirEnPaso(ctx, paso, responderTema(ctx, tm, {}, estado));

  // "¿cuánto sale el kapping?": ese precio (y ofrece reservarlo), no la lista entera.
  const nombrados = inter.servicio ? [inter.servicio] : inter.candidatos;
  if (esPreguntaDePrecio(ctx, t) && !quiereFecha) {
    const precios = `💰 ${nombrados.map((s) => `*${s.nombre}* (${s.duracion_min} min): $${s.precio}${s.sena ? ` — seña $${s.sena}` : ''}`).join('\n')}`;
    if (paso) return seguirEnPaso(ctx, paso, responder(ctx, estado, nombrados.length ? precios : faq.precios(listaServicios(ctx.config))));
    if (!nombrados.length) return sinServicios(ctx) || responder(ctx, 'inicio', faq.precios(listaServicios(ctx.config)));
    if (nombrados.length === 1) ctx.datos.ofrecido = nombrados[0].id;
    const cola = nombrados.length === 1
      ? '¿Querés reservarlo? Respondé *sí*, o *2* para ver todos los precios.'
      : 'Para reservar, escribime cuál (o *1* para ver todos).';
    return responder(ctx, 'inicio', `${precios}\n\n${cola}`);
  }

  // "quiero kapping mañana a las 15" → salta todos los pasos que ya vinieron
  if (inter.servicio) return elegirServicio(ctx, inter.servicio, fh);
  // "quiero un semi" → ¿manos o pies?
  if (inter.candidatos.length === 1) return elegirServicio(ctx, inter.candidatos[0], fh);
  if (inter.candidatos.length > 1) {
    ctx.datos = { fh };
    return responder(ctx, 'eligiendo_servicio',
      `¿Cuál de estos?\n\n${listaServicios(ctx.config, inter.candidatos)}\n\nRespondé con el número (o *menú* para ver todo).`);
  }

  // Mencionar un día u hora ya es querer un turno, aunque no diga "reservar"
  // ("se puede el sábado 10 hs?", "tenés algo mañana a la tarde?")
  if (paso) {
    // A mitad de una reserva, "mejor el martes a la tarde" es para el mismo servicio. Lo demás lo resuelve el paso.
    const s = ctx.datos.servicioId && qServicios.porId(ctx.datos.servicioId);
    return s && quiereFecha ? elegirServicio(ctx, s, fh) : null;
  }
  if (inter.intencion === 'reservar' || quiereFecha) {
    // "quería reservar para el viernes a las 10" sin decir el servicio:
    // guardamos día/hora y los usamos apenas elija el servicio.
    ctx.datos = { fh };
    return preguntarServicio(ctx);
  }

  return null;
}

// Apuro ("??", "hola???", "contestá", "hay alguien?") después de haber visto el menú hace poco: contestar corto, no el
// menú de nuevo. A la segunda, una persona. `ayuda`: la pregunta del paso en el que está (a mitad de una reserva).
function apuro(ctx, ayuda) {
  if (!nlu.esApuro(ctx.msj.texto)) return null;
  const reciente = ctx.datos.menuVisto && Date.now() - ctx.datos.menuVisto < 30 * 60000;
  if (!ayuda && !reciente) return null; // un "hola" de alguien que recién llega es un saludo
  const veces = (ctx.datos.apuros || 0) + 1;
  if (veces >= 2) return derivarAHumano(ctx, ctx.msj.texto, `Perdón la demora 🙏 Ya le aviso ${aQuienAtiende(ctx.config.textos)} para que te responda personalmente.`);
  ctx.datos.apuros = veces;
  return responder(ctx, ctx.clienta.estado_conv || 'inicio', ayuda
    ? `Acá estoy 🙂 ${ayuda}`
    : `Acá estoy 🙂 Escribime lo que necesitás, como te salga: un turno, precios, horarios… o *4* para hablar con ${ctx.config.textos.quien_atiende}.`);
}

// Enojo (insultos, 😡) sin otro pedido en el mensaje: no se discute ni se manda el menú. Perdón, y una persona.
function enojo(ctx) {
  if (!nlu.esInsulto(ctx.msj.texto)) return null;
  return derivarAHumano(ctx, ctx.msj.texto, `Perdón por la molestia 🙏 Ya le aviso ${aQuienAtiende(ctx.config.textos)} para que te atienda personalmente.`);
}

// A mitad de un paso, lo que se contestó (un precio, cómo se paga) sigue con la pregunta del paso: no se pierde dónde
// estaba la reserva.
function seguirEnPaso(ctx, paso, r) {
  if (paso && r && r[0]) r[0].texto += `\n\n${paso.ayuda}`;
  return r;
}

// `ctx.entender` de los turnos (ver noEntendi): una risa no se contesta, un "gracias" no cuenta como no entender, y lo
// demás se prueba con el diccionario.
function entenderEnPaso(ctx, ayuda) {
  const t = ctx.texto;
  if (!t || nlu.esRisa(t)) return [];
  const estado = ctx.clienta.estado_conv;
  if (estado === 'inicio') return null;
  if (nlu.esCortesia(t)) return responder(ctx, estado, `😊 ${ayuda}`);
  return apuro(ctx, ayuda) || entender(ctx, { estado, ayuda }) || enojo(ctx);
}

// "no puedo ir el viernes, ¿me lo pasás para el sábado?": el mismo turno, en otro día u hora. Lo que propone está
// después de "pasás", "puedo", "mejor"… ("no llego a las 10, puedo a las 11" → las 11, no las 10).
function reprogramar(ctx, turno) {
  const servicio = qServicios.porId(turno.servicio_id);
  const partes = ctx.msj.texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/\b(?:puedo|podria|podes|pueden|mejor|pasas|pasan|pasar|pasarlo|pasarla|cambiar|cambias|cambialo|moverlo|correrlo|para el|para la|en vez de)\b/);
  const propuesta = partes.length > 1 ? partes[partes.length - 1] : '';
  const fh = nlu.extraerFechaHora(propuesta);
  if (fh.hora && !fh.dia) fh.dia = turno.inicio.slice(0, 10);
  ctx.datos = { reprogramar: turno.id };
  const r = elegirServicio(ctx, servicio, fh);
  r[0].texto = `🔁 Cambiamos tu turno del ${fechas.diaLindo(turno.inicio.slice(0, 10))} a las ${turno.inicio.slice(11)} (${servicio.nombre}).\n\n${r[0].texto}`;
  return r;
}

function derivarAHumano(ctx, textoCitado, texto) {
  qClientas.derivar(ctx.clienta.id, ctx.config.pausa_minutos);
  return [
    { para: ctx.clienta.telefono, texto: texto || `Dale, le aviso ${aQuienAtiende(ctx.config.textos)} y te responde personalmente en un ratito 🙌` },
    notif.derivacion(ctx.config, ctx.clienta, textoCitado || '(sin texto)'),
  ];
}

function cancelando(ctx) {
  // "sí" es cancelar y "no" es mantenerlo, igual que *1* y *2*.
  if (nlu.esSi(ctx.texto)) ctx.texto = '1';
  else if (nlu.esNo(ctx.texto)) ctx.texto = '2';
  if (ctx.texto === '1') {
    const turno = qTurnos.porId(ctx.datos.turnoCancelar);
    qTurnos.cambiarEstado(turno.id, 'cancelado');
    ctx.datos = {};
    return responder(ctx, 'inicio',
      'Listo, tu turno quedó cancelado. ¡Gracias por avisar! Cuando quieras otro, escribí *hola* 😊',
      [notif.cancelacion(ctx.config, turno, `canceló ${ctx.config.textos.el_cliente}`)]);
  }
  if (ctx.texto === '2') {
    ctx.datos = {};
    return responder(ctx, 'inicio', `¡Perfecto, tu turno sigue en pie! Te esperamos ${ctx.config.textos.emoji}`);
  }
  return noEntendi(ctx, 'Respondé *1* para cancelar o *2* para mantener el turno.');
}

function eligiendo_servicio(ctx) {
  // Primero por nombre, porque puede venir con fecha y hora incluidas
  // ("kapping el 14/8 a las 10") y esos números NO son una selección múltiple.
  const porNombre = nlu.servicioPorNombre(ctx.texto, qServicios.activos(), sinonimos(ctx));
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
  const f = fh || {};
  fh = {
    dia: f.dia || previo.dia || null, hora: f.hora || previo.hora || null,
    horaAmbigua: f.hora ? !!f.horaAmbigua : !!previo.horaAmbigua,
    franja: f.franja || previo.franja || null, desde: f.desde || previo.desde || null,
  };
  // Si está cambiando un turno, se sigue sabiendo cuál (y ese turno no le ocupa el lugar a sí mismo).
  const reprogramarId = ctx.datos.reprogramar || 0;
  ctx.datos = { servicioId: servicio.id, ...(reprogramarId ? { reprogramar: reprogramarId } : {}), ...(fh.franja ? { franja: fh.franja } : {}) };

  // "a las 5" sin decir de la tarde: si a las 5 está cerrado y a las 17 abierto, son las 17.
  if (fh.hora && fh.horaAmbigua) {
    const [h, m] = fh.hora.split(':').map(Number);
    const pm = `${String(h + 12).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    if (!agenda.abiertoA(ctx.config, fh.hora, fh.dia) && agenda.abiertoA(ctx.config, pm, fh.dia)) fh.hora = pm;
  }

  // "la semana que viene", "a la tarde": los días que cumplen; si ninguno, todos.
  let dias = agenda.diasDisponibles(ctx.config, servicio, { desde: fh.desde, franja: fh.franja, excluirId: reprogramarId });
  if (!dias.length && (fh.desde || fh.franja)) dias = agenda.diasDisponibles(ctx.config, servicio, { excluirId: reprogramarId });
  if (!dias.length) {
    return responder(ctx, 'inicio', `Uy, no tengo horarios libres en los próximos días 😔 Escribí *4* si querés coordinar directo con ${ctx.config.textos.quien_atiende}.`);
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
    const horas = horasEnFranja(agenda.horariosLibres(ctx.config, servicio, fh.dia, reprogramarId), fh.franja);
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
  // "el martes", "mañana", "el jueves a las 5": como lo dice la gente, no solo el número de la lista.
  const fh = nlu.extraerFechaHora(ctx.msj.texto || '');
  if (fh.dia) return elegirServicio(ctx, qServicios.porId(ctx.datos.servicioId), { ...fh, franja: fh.franja || ctx.datos.franja });
  const nums = numerosDe(ctx.texto);
  if (nums.length > 1) {
    return responder(ctx, 'eligiendo_dia', 'Elegí *un solo día* (un número de la lista) 😊');
  }
  const i = (nums[0] ?? 0) - 1;
  const dia = i >= 0 ? dias[i] : null;
  if (!dia) return noEntendi(ctx, 'Elegí un número de la lista de días, o *0* para volver.');
  return pedirHorarios(ctx, dia);
}

// Los horarios de la franja que pidió ("a la tarde"); si esa franja no tiene ninguno, todos.
function horasEnFranja(horas, franja) {
  const enFranja = horas.filter((h) => nlu.enFranja(h, franja));
  return enFranja.length ? enFranja : horas;
}

function pedirHorarios(ctx, dia) {
  const servicio = qServicios.porId(ctx.datos.servicioId);
  const horas = horasEnFranja(agenda.horariosLibres(ctx.config, servicio, dia, ctx.datos.reprogramar || 0), ctx.datos.franja);
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
  // "a las 5", "16 hs", "tipo 4 y media": la hora, no el número de opción ("a las 5" son las 17 si a las 5 no hay).
  // Un número solo ("5") sigue siendo la opción de la lista, que es lo que se le pidió.
  const fh = hLit ? {} : nlu.extraerFechaHora(ctx.msj.texto || '');
  if (fh.dia && fh.dia !== ctx.datos.dia) return elegirServicio(ctx, qServicios.porId(ctx.datos.servicioId), fh);
  if (!hora && fh.hora) {
    const [h, m] = fh.hora.split(':').map(Number);
    const tarde = `${String(h + 12).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    hora = horas.find((x) => x === fh.hora) || (fh.horaAmbigua ? horas.find((x) => x === tarde) : null);
    if (!hora) {
      return responder(ctx, 'eligiendo_hora',
        `Uy, a esa hora no tengo lugar ese día 😕 Estos horarios sí:\n\n${horas.map((x, j) => `*${j + 1}* — ${x}`).join('\n')}\n\nRespondé con el número, o *0* para volver.`);
    }
  }
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
  if (ctx.datos.reprogramar) {
    const antes = qTurnos.porId(ctx.datos.reprogramar);
    return responder(ctx, 'confirmando',
      `Perfecto ${ctx.clienta.nombre}, repasemos el cambio:\n\n${ctx.config.textos.emoji} ${s.nombre}\n🔁 Antes: ${fechas.diaLindo(antes.inicio.slice(0, 10))} a las ${antes.inicio.slice(11)}\n📅 Ahora: ${fechas.diaLindo(ctx.datos.dia)} a las ${ctx.datos.hora}\n\n*1* — Confirmar el cambio\n*2* — Elegir otro horario\n*0* — Dejarlo como estaba`);
  }
  const senaTxt = (ctx.config.senas.habilitadas && s.sena > 0)
    ? `\n💸 Seña para reservar: $${s.sena}` : '';
  return responder(ctx, 'confirmando',
    `Perfecto ${ctx.clienta.nombre}, repasemos:\n\n${ctx.config.textos.emoji} ${s.nombre}\n📅 ${fechas.diaLindo(ctx.datos.dia)} a las ${ctx.datos.hora}\n💰 $${s.precio}${senaTxt}\n\n*1* — Confirmar\n*2* — Cambiar\n*0* — Cancelar`);
}

function confirmando(ctx) {
  if (ctx.datos.reprogramar) return confirmandoCambio(ctx);
  if (nlu.esSi(ctx.texto) || /^(?:confirmo|confirmar|confirmado|reservalo|agendalo)$/.test(nlu.normalizar(ctx.texto))) ctx.texto = '1';
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
      `¡Turno confirmado! 🎉\n📅 ${fechas.diaLindo(ctx.datos.dia || turno.inicio.slice(0, 10))} a las ${turno.inicio.slice(11)}\n${ctx.config.textos.emoji} ${s.nombre}\n\nTe mandamos un recordatorio un día antes. ¡Te esperamos!`,
      [notif.turnoConfirmado(ctx.config, turno),
       ...notif.invitacionCalendario(ctx.config, turno),
       ...notif.tarjetaContacto(ctx.config, ctx.clienta, turno)]);
  }

  const venceEn = fechas.aTexto(new Date(Date.now() + ctx.config.senas.vencimiento_horas * 3600000));
  qSenas.crear(turnoId, s.sena, venceEn);
  ctx.datos = { turnoId };
  if (senasFlujo.cobraConLink(ctx.config)) {
    // El link lo crea Nodo Sur al recibir el turno y sale en el mensaje siguiente (`nube/sincronizar.js`, mandarTurnos).
    return responder(ctx, 'esperando_comprobante',
      `¡Casi listo! Para reservar te pido una seña de *$${s.sena}*. Ya te mando el link de Mercado Pago para pagarla 💳\n\nTenés ${senasFlujo.plazoTexto(ctx.config)}, después el horario se libera solo 😉`);
  }
  return responder(ctx, 'esperando_comprobante',
    `¡Casi listo! Para reservar te pido una seña de *$${s.sena}* por transferencia:\n\n🏦 Alias: *${ctx.config.senas.alias_mp}*\n👤 Titular: ${ctx.config.senas.titular}\n\nCuando la hagas, mandame la *foto del comprobante* por acá. Tenés ${senasFlujo.plazoTexto(ctx.config)}, después el horario se libera solo 😉`);
}

// Confirmar el cambio de un turno: se mueve el MISMO turno (con su seña, si la tenía) al horario nuevo.
function confirmandoCambio(ctx) {
  const id = ctx.datos.reprogramar;
  const s = qServicios.porId(ctx.datos.servicioId);
  if (nlu.esSi(ctx.texto) || /^(?:confirmo|confirmar|cambialo)$/.test(nlu.normalizar(ctx.texto))) ctx.texto = '1';
  if (ctx.texto === '2') return elegirServicio(ctx, s);
  if (ctx.texto === '0') { ctx.datos = {}; return responder(ctx, 'inicio', `Listo, tu turno sigue como estaba ${ctx.config.textos.emoji}`); }
  if (ctx.texto !== '1') return noEntendi(ctx, 'Respondé *1* para confirmar el cambio, *2* para elegir otro horario o *0* para dejarlo como estaba.');

  const antes = qTurnos.porId(id);
  if (!antes || !['pendiente_sena', 'confirmado'].includes(antes.estado)) {
    ctx.datos = {};
    return responder(ctx, 'inicio', 'Ese turno ya no está activo 🤔 Si querés sacar uno nuevo, escribí *1*.');
  }
  const inicioT = `${ctx.datos.dia} ${ctx.datos.hora}`;
  const finT = fechas.sumarMinutos(inicioT, s.duracion_min);
  if (qTurnos.haySolapamiento(inicioT, finT, id)) {
    const r = elegirServicio(ctx, s);
    r[0].texto = `Uy, justo ese horario lo acaban de reservar 😔 Elegí otro:\n\n${r[0].texto}`;
    return r;
  }
  qTurnos.mover(id, inicioT, finT);
  const turno = qTurnos.porId(id);
  ctx.datos = {};
  return responder(ctx, 'inicio',
    `¡Listo! Tu turno quedó para el ${fechas.diaLindo(turno.inicio.slice(0, 10))} a las ${turno.inicio.slice(11)} ${ctx.config.textos.emoji}\nTe mandamos un recordatorio un día antes.`,
    [notif.turnoMovido(ctx.config, antes, turno), ...notif.invitacionCalendario(ctx.config, turno)]);
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
        [notif.cancelacion(ctx.config, turno, `canceló ${ctx.config.textos.el_cliente} antes de señar`)]);
    }
    if (senasFlujo.cobraConLink(ctx.config)) {
      return responder(ctx, 'esperando_comprobante',
        'Te espero con el pago de la seña por el link de Mercado Pago 💳 Apenas entra, te confirmo el turno solo.\nSi te arrepentiste, escribí *0* y libero el horario.');
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

// Lo común con la conversación de un comercio (`comercio.js`): una sola forma de responder, de "no entendí" y de pasarle
// la charla a una persona.
module.exports = { procesar, responder, noEntendi, anotarNoEntendido, derivarAHumano, responderTema, numerosDe, apuro, enojo, menuVisto: (ctx) => { ctx.datos.menuVisto = Date.now(); } };
