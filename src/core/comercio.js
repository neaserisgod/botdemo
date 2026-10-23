// Conversación de un comercio (forma productos: almacén, kiosco, fiambrería). Decisiones del dueño (2026-10-09,
// Nodo-Sur-Pos/docs/PLAN-BOT.md):
//  * contesta precio y si hay, sacado del catálogo que publica Nodo Sur (`catalogo.js`);
//  * contesta ubicación y horarios;
//  * toma pedidos para RETIRAR EN EL LOCAL (sin envío). Un producto sin stock no se agrega (sin stock no se vende);
//  * el precio es el de hoy y puede cambiar: el que vale es el del día que retira (como cualquier encargue);
//  * el pedido entra en Nodo Sur "por confirmar" (no aparta stock): el bot lo guarda en la bandeja (`pedidos`), `nube/`
//    lo manda y, cuando el local lo acepta o rechaza en la app, `avisoDePedido` arma el mensaje para el cliente.
//  * un local gastronómico (rubro rotisería, con `config.pedidos` de Nodo Gastro) además ofrece la carta, retiro o envío con
//    zona, dice a qué hora sale (fuera de hora queda programado), no toma nada con la cocina pausada y pregunta cómo paga
//    (`gastro.js`; REGLAS-NEGOCIO §22 de Nodo-Sur-Pos). El precio dicho es el que vale.
//
// Estados (en clientas.estado_conv, como los turnos): inicio ⇄ consultando (después del "1": cada mensaje es un producto);
// inicio → armando_pedido ⇄ eligiendo_producto / eligiendo_peso → pidiendo_nombre → confirmando_pedido → inicio.
// Gastronómico, entre el pedido y el resumen: eligiendo_entrega → pidiendo_direccion → eligiendo_zona → pidiendo_nombre → eligiendo_pago.
const qClientas = require('../db/consultas/clientas');
const qPedidos = require('../db/consultas/pedidos');
const catalogo = require('./catalogo');
const gastro = require('./gastro');
const faq = require('./flujos/faq');
const nlu = require('./nlu');
const numeros = require('./diccionario/numeros');
const fechas = require('./fechas');
const rubros = require('./diccionario/rubros');
const { responder, noEntendi, anotarNoEntendido, derivarAHumano, responderTema, numerosDe, apuro, enojo, menuVisto } = require('./maquina');
const { aQuienAtiende } = require('../plantillas');

// Los sinónimos de productos del rubro (diccionario/rubros.js): "birra" → cerveza, "puchos" → cigarrillos.
const sinonimos = (ctx) => rubros.productosDe(ctx.config.negocio.rubro);
// Un comercio no hace envíos (decisión del dueño, 2026-10-09): si el negocio no cargó otra cosa, eso se contesta.
const POR_DEFECTO = { envios: 'Por ahora los pedidos son para *retirar en el local* 🙌 Para armar uno, escribí *pedido*.' };
// Un local gastronómico dice lo que hace él (Nodo Gastro manda sus formas de entrega y zonas).
function porDefecto(ctx) {
  if (!gastro.esGastro(ctx.config)) return POR_DEFECTO;
  // En medio de un pedido no se le dice "escribime pedido": ya lo está armando.
  const armando = !['inicio', 'consultando'].includes(ctx.clienta.estado_conv || 'inicio');
  const pagos = textoPagos(ctx.config);
  if (!gastro.formas(ctx.config).some((f) => f.envio)) return { envios: armando ? 'Por ahora los pedidos son para *retirar en el local* 🙌' : POR_DEFECTO.envios, pagos };
  const zs = gastro.zonas(ctx.config);
  const lista = zs.length ? `\n${zs.map((z) => `• ${z.nombre} — ${precioEnvio(gastro.costoEnvio({ envio: true }, z))}`).join('\n')}` : '';
  return { envios: `¡Sí, te lo llevamos! 🛵${lista}${armando ? '' : '\nCuando quieras armar el pedido, escribime *pedido*.'}`, pagos };
}

// Los temas de siempre, más "¿tienen alias?" en un local gastronómico. "alias" va aparte y como palabra exacta: en la lista
// común el corrector de tipeo lo encontraba en "turno alas 5".
function temaDe(ctx, t) {
  const tm = nlu.tema(ctx.config, t);
  if (tm || !gastro.esGastro(ctx.config)) return tm;
  return /\balias\b/.test(nlu.normalizar(t)) ? { tema: 'pagos' } : null;
}

// "¿Aceptan tarjeta?", "¿tienen alias?": un local gastronómico ya dijo cómo se le paga (Configurar pedidos); antes la pregunta
// iba al dueño aunque el bot lo sabía (El dueño, 2026-10-23).
function textoPagos(config) {
  const p = config.pedidos || {};
  const formas = gastro.pagos(config).map((x) => ({
    al_entregar: '💵 Al recibir el pedido',
    mp: '💳 Mercado Pago (te paso el link al confirmar)',
    alias: `🏦 Transferencia al alias *${p.alias}*${p.titular ? ` (a nombre de ${p.titular})` : ''}`,
  })[x]);
  return `Podés pagar así:\n${formas.map((f) => `• ${f}`).join('\n')}`;
}

// Un envío que no cuesta nada se dice como lo diría alguien del local, no "$0".
const precioEnvio = (centavos) => (centavos > 0 ? catalogo.plata(centavos) : 'sin cargo');

const AVISO_PRECIO = '_Precios de hoy, pueden cambiar._';
const MAX_LINEAS = 50; // lo que acepta Nodo Sur por pedido

function procesar(config, clienta, msj) {
  const texto = (msj.texto || '').trim();
  let datos = {};
  try { datos = JSON.parse(clienta.datos_conv || '{}') || {}; } catch {
    console.error(`datos_conv inválido en ${clienta.id}, reiniciando su estado`);
    clienta.estado_conv = 'inicio';
  }
  const ctx = { config, clienta, datos, msj, texto: texto.toLowerCase(), entender: entenderEnPaso };

  if (nlu.esVolverAlMenu(texto)) {
    ctx.datos = {};
    return menu(ctx, '¡Volvamos al principio!');
  }
  // El carrito del catálogo de WhatsApp Business: se toma como un pedido entero, en cualquier paso.
  if (msj.carrito) return carritoDelCatalogo(ctx);
  const manejadores = {
    inicio, consultando, armando_pedido, eligiendo_producto, eligiendo_peso, pidiendo_nombre, confirmando_pedido,
    eligiendo_entrega, pidiendo_direccion, eligiendo_zona, eligiendo_pago, eligiendo_dia,
  };
  return (manejadores[clienta.estado_conv] || inicio)(ctx);
}

function menu(ctx, saludo) {
  const encabezado = saludo ? `${saludo}\n\n` : '';
  menuVisto(ctx);
  const g = gastro.esGastro(ctx.config);
  const ver = g ? `Ver la carta ${ctx.config.textos.emoji}` : `Consultar precios ${ctx.config.textos.emoji}`;
  const pedir = g ? 'Hacer un pedido' : 'Hacer un pedido para retirar';
  const pregunta = g ? '¿Qué te preparamos?' : '¿Qué necesitás?';
  const pie = g ? `Elegí un número, o escribime directo lo que querés${ejemploDeLaCarta(ctx, ' (ej: ', ')')}.` : 'Respondé con el número, o escribime directo qué buscás.';
  return responder(ctx, 'inicio',
    `${encabezado}${pregunta}\n\n*1* — ${ver}\n*2* — ${pedir}\n*3* — ${g ? 'Horarios y envíos' : 'Ubicación y horarios'}\n*4* — Hablar con una persona\n\n${pie}`);
}

// Un ejemplo de pedido con algo que el local tiene hoy ("*1 combo la km 13*"): lo más corto de la carta, así se lee fácil.
function ejemploDeLaCarta(ctx, antes = '', despues = '') {
  if (!catalogo.cargado()) return '';
  const hay = catalogo.todos().filter((x) => x.hay).sort((a, b) => a.nombre.length - b.nombre.length);
  return hay.length ? `${antes}*1 ${sinDescripcion(hay[0].nombre).toLowerCase()}*${despues}` : '';
}

// El saludo: un local gastronómico agradece como lo haría alguien del local; el resto se presenta como asistente.
const saludo = (ctx) => (gastro.esGastro(ctx.config)
  ? `¡Hola! 👋 Gracias por escribir a *${ctx.config.negocio.nombre}*.${avisoDeDias(ctx)}`
  : `¡Hola! 👋 Soy el asistente de *${ctx.config.negocio.nombre}*.`);

// Hoy no hay entregas (un local que entrega solo el finde): se dice de entrada para cuándo toma pedidos.
function avisoDeDias(ctx) {
  const dias = gastro.proximosDias(ctx.config, 3);
  if (!dias.length || dias[0].ymd === fechas.hoyYmd()) return '';
  const nombres = dias.map((x) => fechas.diaLindo(x.ymd).split(' ')[0]);
  const lista = nombres.length > 1 ? `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}` : nombres[0];
  return `\n🗓️ Hoy no hacemos entregas, pero ya tomamos pedidos para el ${lista.toLowerCase()} 🙌`;
}

const sinCatalogo = (ctx) => responder(ctx, 'inicio',
  'Todavía no tengo cargada la lista de precios 😅 Escribí *4* y te responde una persona.');

// Una línea por producto: "Coca 2,25 L — $3.500 ✅" o "… ❌ sin stock".
const lineaProducto = (x) => `• ${nombreConPrecio(x)} ${x.hay ? '✅' : '❌ sin stock'}`;

// ---------- inicio: consultas ----------
const PIDE_PEDIDO = ['pedido', 'pedir', 'pedirte', 'pedirle', 'pedirles', 'hacer un pedido', 'quiero pedir', 'encargar', 'encargo', 'reservar'];
const PIDE_PRECIO = ['precio', 'precios', 'cuanto', 'sale', 'cuesta', 'vale', 'hay', 'tienen', 'tenes', 'queda', 'quedan', 'stock'];

// Después del "1" (consultar precios) cada mensaje es un producto: lo que no está dice "no encontré" (no el menú) y se
// sigue consultando sin volver a poner "1". Lo demás (las otras opciones, "pedido", "gracias", "hola") anda como en inicio.
const consultando = (ctx) => inicio(ctx, 'consultando');

function inicio(ctx, estado = 'inicio') {
  let t = ctx.texto;
  const sinEntender = ctx.datos.sinEntender || 0;
  delete ctx.datos.sinEntender;
  // La foto del comprobante de la transferencia: se le pasa al local (antes no la veía nadie y el cliente quedaba sin respuesta).
  if (ctx.msj.rutaImagen && gastro.esGastro(ctx.config)) {
    const comp = comprobante(ctx);
    if (comp) return comp;
  }
  if (!t || nlu.esRisa(t)) return [];
  if (nlu.esCortesia(t)) return responder(ctx, 'inicio', '¡Gracias a vos! 😊 Cualquier cosa escribime *hola*.');
  const apurado = apuro(ctx);
  if (apurado) return apurado;
  // Las opciones del menú como las escriba ("1.", "el 1", "opción 2", "uno")
  const op = nlu.opcionMenu(t);
  if (op && op <= 4) t = String(op);

  if (t === '1' && gastro.esGastro(ctx.config)) return carta(ctx);
  if (t === '1') return responder(ctx, 'consultando', `Decime qué producto buscás y te paso el precio y si hay ${ctx.config.textos.emoji}\n(por ejemplo: *coca*, *pan lactal*)`);
  if (t === '2') return empezarPedido(ctx);
  if (t === '3') return faq.conPin(responder(ctx, 'inicio', faq.ubicacionYHorarios(ctx.config)), ctx.config);
  if (t === '4') return derivarAHumano(ctx, '(pidió hablar con una persona)');

  const norm = nlu.normalizar(t);
  const tokens = norm.split(' ');
  const inter = nlu.interpretar(t);
  // Lo que pasa con el pedido que ya mandó: cuánto falta, cancelarlo, cambiarlo; y "lo mismo que la otra vez".
  const delPedido = gastro.esGastro(ctx.config) && despuesDelPedido(ctx, norm);
  if (delPedido) return delPedido;
  // "hola, ¿me podés cortar 200 de jamón, 1/4 de queso y 100 de salame?": el pedido entero en el primer mensaje.
  const enMensaje = pedidoEnElMensaje(ctx);
  if (enMensaje) return enMensaje;
  // "¿me pasás el catálogo?", "¿qué tienen en la carta?": la carta (o el link del catálogo de WhatsApp).
  if (gastro.esGastro(ctx.config) && /\b(?:catalogo|carta|que tienen hoy|que hay hoy)\b/.test(norm)) return carta(ctx);
  // "¿Precios?", "¿qué tienen?", "¿qué venden?": sin nombrar un producto, es la carta (antes iba a una persona).
  if (gastro.esGastro(ctx.config) && !catalogo.palabrasClave(t).length
    && /\b(?:precio|precios|lista|que tienen|que hay|que venden|que ofrecen|que preparan|que cocinan|menu del dia)\b/.test(norm)) return carta(ctx);
  if (PIDE_PEDIDO.some((k) => nlu.contiene(norm, tokens, k))) return empezarPedido(ctx);

  // Lo que pregunta en el mismo mensaje va antes que pasarlo a una persona: "¿alguien me atiende? quiero saber si tienen
  // leche" se contesta con la leche (y la opción de hablar con alguien).
  const buscado = catalogo.palabrasClave(t).length && catalogo.cargado() ? catalogo.buscar(t, 5, sinonimos(ctx)) : null;
  // Envíos, cómo se paga, horarios, ubicación y las preguntas que cargó el negocio. Las del negocio van antes que pasarlo a
  // una persona: si el local cargó qué contestar a "¿sos un bot?", lo contesta él (si no, sigue yendo a una persona).
  const tm = temaDe(ctx, t);
  const estadoTema = estado === 'consultando' ? 'consultando' : 'inicio';
  if (tm && tm.tema === 'pregunta') return responderTema(ctx, tm, porDefecto(ctx), estadoTema);
  if (inter.intencion === 'humano' && !(buscado && buscado.resultados.length)) return derivarAHumano(ctx, ctx.msj.texto);
  if (tm) return responderTema(ctx, tm, porDefecto(ctx), estadoTema);

  // "¿cuánto sale 1/4 de jamón?": lo que sale ese peso.
  const conPeso = precioDePeso(ctx, estado);
  if (conPeso) return conPeso;

  const pregunta = PIDE_PRECIO.some((k) => tokens.includes(k)) || t.includes('?');
  if (catalogo.palabrasClave(t).length) {
    if (!catalogo.cargado()) return sinCatalogo(ctx);
    const { resultados, total } = buscado;
    if (resultados.length) {
      const mas = total > resultados.length ? `\n…y ${total - resultados.length} más: decime algo más específico.` : '';
      const persona = inter.intencion === 'humano' ? '\nSi igual querés hablar con una persona, escribí *4*.' : '';
      return responder(ctx, estado, `${resultados.map(lineaProducto).join('\n')}${mas}\n\n${AVISO_PRECIO}\nPara pedir, escribí *pedido*.${persona}`);
    }
    // Preguntó por algo que no está (o está consultando): no es que no lo entendimos, pero queda anotado (puede ser
    // una palabra que le falta al diccionario).
    if (estado === 'consultando' && inter.intencion !== 'saludo') {
      anotarNoEntendido(ctx);
      return responder(ctx, estado, `No encontré "${ctx.msj.texto.trim()}" 🤔 Probá con otro nombre, escribí *4* para preguntarle a una persona o *menú* para ver las opciones.`);
    }
    if (pregunta && inter.intencion !== 'saludo') {
      anotarNoEntendido(ctx);
      const parecidos = catalogo.parecidos(t, 5, sinonimos(ctx));
      if (parecidos.length) {
        return responder(ctx, estado, `No tengo justo eso 🤔 Lo más parecido:\n${parecidos.map(lineaProducto).join('\n')}\n\n${AVISO_PRECIO}\nPara pedir, escribí *pedido*.`);
      }
      // "¿De qué están hechas?", "¿tienen tacc?": en un local gastronómico casi siempre es una pregunta sobre la comida, no
      // un producto que falta. Decir "no encontré ese producto" suena a que no entendió nada; lo que el local quiera
      // contestar a eso se carga en la app (Preguntas del bot) y queda anotado en "qué no entendiste".
      if (gastro.esGastro(ctx.config)) {
        return responder(ctx, estado, `Esa no la sé responder 😅 ${mirarCarta(ctx)}Si querés preguntarle a una persona, escribí *4*.`);
      }
      return responder(ctx, estado, 'No encontré ese producto 🤔 Probá con otro nombre, o escribí *4* para preguntarle a una persona.');
    }
  }
  // Enojo sin otro pedido: perdón, y una persona.
  const enojado = enojo(ctx);
  if (enojado) return enojado;
  if (inter.intencion === 'saludo') return menu(ctx, saludo(ctx));
  // Lo que no se entendió queda anotado; a la segunda seguida, una persona en vez del menú otra vez.
  anotarNoEntendido(ctx);
  if (sinEntender >= 1) {
    return derivarAHumano(ctx, ctx.msj.texto, `Perdón, no te estoy entendiendo 😅 Ya le aviso ${aQuienAtiende(ctx.config.textos)} para que te responda personalmente.`);
  }
  ctx.datos.sinEntender = sinEntender + 1;
  if (!pregunta) return menu(ctx, saludo(ctx));
  return responder(ctx, estado, 'No te entendí bien 🤔 Decime qué producto buscás, o escribí *menú* para ver las opciones.');
}

// El peso que se nombra en cualquier lugar del mensaje ("¿cuánto sale 1/4 de jamón?") y lo que sale, si es un pesable.
function precioDePeso(ctx, estado) {
  if (!catalogo.cargado()) return null;
  const palabras = (ctx.msj.texto || '').replace(/[¿?!¡]/g, ' ').trim().split(/\s+/);
  for (let i = 0; i < palabras.length; i++) {
    const p = numeros.pesoInicial(palabras.slice(i).join(' '));
    if (!p) continue;
    const pesables = catalogo.buscar(p.resto, 5, sinonimos(ctx)).resultados.filter(catalogo.esPesable);
    if (!pesables.length) return null;
    const lineas = pesables.map((x) => `• ${numeros.textoPeso(p.gramos)} de ${catalogo.nombreCorto(x)} — ${catalogo.plata(catalogo.precioDeGramos(x.precioCentavos, p.gramos))} (a ${catalogo.plata(x.precioCentavos)} el kilo)${x.hay ? '' : ' ❌ sin stock'}`);
    return responder(ctx, estado, `${lineas.join('\n')}\n\n${AVISO_PRECIO}\nPara pedir, escribí *pedido*.`);
  }
  return null;
}

// ---------- pedido ----------
// Verbos de pedido de mostrador: "cortame", "¿me podés cortar…?", "preparame", "separame", "dame", "quiero", "me llevo".
const VERBO_PEDIDO = '(?:me )?(?:podes |podrias |puedes |vas a )?(?:cortar|cortame|cortas|preparar|preparame|preparas|separar|separame|separas|guardar|guardame|guardas|anotar|anotame|anotas|dar|dame|das|mandar|mandame|quiero|quisiera|queria|necesito|me llevo|llevo|encargar|encargo|pedirte|pedirle|pedirles|pedir|pido|traeme|me traes)';
// También las muletillas de arranque ("dale quiero una doble", "bueno, 2 especiales"): sin esto el verbo no quedaba al
// principio y el pedido se tomaba como charla (El dueño, 2026-10-23, prueba con la carta de Groove).
const SALUDO_INICIAL = /^(?:(?:hola|holis|holaa+|buenas|buen dia|buenos dias|buenas tardes|buenas noches|che|como va|que tal|disculpa|perdon|dale|bueno|buenisimo|ok|okey|oka|joya|perfecto|genial|barbaro|entonces|si)[\s,!.¡¿?]*)+/;
const RELLENO_FINAL = /[\s,.!?¿¡]*(?:(?:porfa|por favor|gracias|plis|please|dale)[\s,.!?¿¡]*)*$/;

// "Quería una doble. Para De los Satélites 12963", "2 empanadas, dirección Mitre 150, timbre B": la dirección que viene con
// el pedido no es un producto. Desde ese renglón hasta el final es la dirección (sigue con el timbre o la seña); se guarda
// para el envío. "Para" o "en" solos no alcanzan: hace falta un número que no sea una hora ni un día ("para las 21").
const ABRE_DIRECCION = /^(?:(?:mi |la )?(?:direccion|domicilio)\b(?: es)?:?|(?:es |seria |lo quiero )?para|(?:llevalo|llevamelo|mandalo|mandamelo|traelo|traemelo|envialo|enviamelo) a|a domicilio en|vivo en|estoy en|en)\s+/;
function separarDireccion(texto) {
  const partes = String(texto || '').split(/(\n|[.;,](?!\d)|(?<!\d)[.;,])/);
  for (let i = 0; i < partes.length; i += 2) {
    const n = partes[i].trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const m = n.match(ABRE_DIRECCION);
    if (!m) continue;
    const resto = n.slice(m[0].length);
    const conPalabra = /^(?:direccion|domicilio|mi |la )/.test(m[0]);
    const conNumero = /[a-z]{3,}/.test(resto) && /\b\d{2,5}\b/.test(resto)
      && !/\b(?:el|las?|hs|horas?)\s*\d|\d\s*(?:hs|horas?)\b/.test(resto);
    if (!conPalabra && !conNumero) continue;
    const direccion = (partes[i].trim().slice(m[0].length) + partes.slice(i + 1).join('')).replace(/^[\s:]+|[\s.,;]+$/g, '');
    if (direccion.length < 4) continue;
    return { texto: partes.slice(0, i).join('').replace(/[\s.,;]+$/, ''), direccion: direccion.slice(0, 160) };
  }
  return { texto: String(texto || ''), direccion: null };
}

// La dirección que dijo con el pedido: si el local hace envíos, ya queda elegido el envío y no se le pregunta de nuevo.
function guardarDireccion(ctx, direccion) {
  if (!direccion || !gastro.esGastro(ctx.config)) return;
  const envio = gastro.formas(ctx.config).find((f) => f.envio);
  if (!envio) return;
  ctx.datos.direccion = direccion;
  ctx.datos.entrega = envio.clave;
}

// Si el mensaje es un pedido ("hola, ¿me podés cortar 200 de jamón y 1/4 de queso?", "quiero 2 cocas y 1/4 de jamón"),
// arranca el pedido con todo anotado. Hace falta un verbo de pedido o que algún renglón traiga cantidad o peso, y que
// algún producto exista; "¿cuánto sale el 1/4 de jamón?" o "¿tienen coca?" siguen siendo consultas.
function pedidoEnElMensaje(ctx) {
  if (!catalogo.cargado()) return null;
  const { texto, direccion } = separarDireccion(ctx.msj.texto);
  let t = texto.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(SALUDO_INICIAL, '');
  const norm = nlu.normalizar(t);
  if (/\b(?:cuanto|cuanta|precio|precios|sale|salen|cuesta|cuestan|vale|valen)\b/.test(norm)) return null;
  // "quiero pedirte un combo": puede haber más de un verbo seguido.
  const conVerbo = new RegExp(`^(?:${VERBO_PEDIDO}\\b\\s*)+`);
  const verbo = conVerbo.test(t);
  t = t.replace(conVerbo, '').replace(RELLENO_FINAL, '');
  let lineas = separarLineas(t);
  if (!lineas.length) return null;
  const esProducto = ({ r }) => ['anotar', 'elegir', 'pesar', 'paquete'].includes(r.tipo);
  let leidas = lineas.map((l) => ({ l, r: leerLinea(ctx, l) }));
  // "¿me cortás jamón y queso?": si así no hay producto, la "y" separa dos.
  if (!leidas.some(esProducto) && /\s+y\s+/.test(t)) {
    lineas = lineas.flatMap((l) => l.split(/\s+y\s+/)).filter(Boolean);
    leidas = lineas.map((l) => ({ l, r: leerLinea(ctx, l) }));
  }
  // "Quería una doble con papas" sin un plato que se llame así: con el verbo es un pedido igual, y se pregunta cuál de los
  // parecidos (los dobles) en vez de mandar el menú.
  const productos = leidas.filter((x) => esProducto(x) || (verbo && x.r.tipo === 'parecidos'));
  const conCantidad = leidas.some(({ l }) => numeros.pesoInicial(l) || numeros.cantidadInicial(l));
  if (!productos.length || !(verbo || conCantidad)) return null;
  if (gastro.pausada(ctx.config)) return cocinaPausada(ctx);
  ctx.datos = { items: [] };
  guardarDireccion(ctx, direccion);
  const r = anotarVarias(ctx, lineas, []);
  r[0].texto = `${encabezadoPedido(ctx)}\n\n${r[0].texto}`;
  return r;
}

// Un almacén prepara para retirar; un local gastronómico dice después cómo se entrega (ver `siguienteGastro`).
const encabezadoPedido = (ctx) => (gastro.esGastro(ctx.config)
  ? `¡Dale! ${ctx.config.textos.emoji}`
  : `¡Dale! ${ctx.config.textos.emoji} Lo preparamos para que lo *retires en el local*.`);

// Con la cocina pausada (la app: "Cocina › Pausada") no se toma nada: el local está tapado o cerró la cocina un rato.
const cocinaPausada = (ctx) => {
  ctx.datos = {};
  return responder(ctx, 'inicio', '😕 En este momento la cocina no está tomando pedidos. Probá en un ratito, o escribí *4* para hablar con una persona.');
};

// El último pedido, si todavía está en curso (no entregado, cancelado ni rechazado) y es de las últimas horas.
const EN_CURSO = ['por_enviar', 'enviado', 'aceptado', 'listo', 'en_camino', 'a_mano'];
function pedidoEnCurso(ctx) {
  const p = qPedidos.ultimoDe(ctx.clienta.id);
  if (!p || !EN_CURSO.includes(p.estado)) return null;
  const hora = p.datos.horaEstimada || Date.parse(String(p.creado_en).replace(' ', 'T'));
  return Number.isFinite(hora) && Date.now() - hora < 6 * 3600000 ? p : null;
}

const ESTADO_DEL_PEDIDO = {
  por_enviar: 'le está llegando al local', enviado: 'lo tiene el local, falta que lo confirme', a_mano: 'lo tiene el local, falta que lo confirme',
  aceptado: 'está confirmado y en la cocina 🍳', listo: 'está listo 🍽️', en_camino: 'ya salió, va para tu casa 🛵',
};

// Después de confirmar: "¿cuánto falta?", "quiero cancelarlo", "me olvidé la coca" (lo resuelve el local: el pedido ya es de
// la app) y "lo mismo que la otra vez". Null si no es nada de eso.
function despuesDelPedido(ctx, norm) {
  const enCurso = pedidoEnCurso(ctx);
  if (enCurso) {
    const hora = enCurso.datos.programado && enCurso.datos.horaEstimada
      ? ` Sale ${textoDia(new Date(enCurso.datos.horaEstimada))}.`
      : ' Te aviso por acá apenas salga.';
    if (/\b(?:cancel\w*|anul\w*|no lo quiero|ya no quiero|me arrepenti)\b/.test(norm)) {
      return derivarAHumano(ctx, `Quiere CANCELAR su pedido: "${ctx.msj.texto}"`, 'Le aviso al local para cancelarlo 🙏 Te confirman por acá en un ratito.');
    }
    if (/\b(?:agreg\w*|sum\w*|me olvide|olvide|cambi\w*|sac\w*|quit\w*|en vez de|mejor sin|tambien quiero)\b/.test(norm)) {
      return derivarAHumano(ctx, `Quiere CAMBIAR su pedido: "${ctx.msj.texto}"`, 'Tu pedido ya está en la cocina, así que le paso el cambio al local 🙌 Te confirman por acá.');
    }
    if (/\b(?:cuanto (?:tarda|falta|demora|le falta)|falta mucho|tarda mucho|ya (?:esta|sale|salio|viene)|esta listo|mi pedido|donde (?:esta|viene)|cuando (?:llega|sale|esta)|llega|demora)\b/.test(norm)) {
      return responder(ctx, 'inicio', `Tu pedido ${ESTADO_DEL_PEDIDO[enCurso.estado]}.${hora}\nSi necesitás algo más, escribí *4* y te responde una persona.`);
    }
  }
  const demora = cuantoTarda(ctx, norm);
  if (demora) return responder(ctx, 'inicio', `${demora}\nPara pedir, escribí *pedido*.`);
  if (/\b(?:lo mismo|lo de siempre|el de siempre|repet\w*|el mismo pedido|igual que (?:la otra vez|ayer|siempre|la ultima))\b/.test(norm)) return repetirPedido(ctx);
  return null;
}

// "Lo mismo que la otra vez": el último pedido, con los precios de hoy y solo lo que hay.
function repetirPedido(ctx) {
  const anterior = qPedidos.ultimoDe(ctx.clienta.id);
  if (!anterior || !catalogo.cargado()) return null;
  if (gastro.pausada(ctx.config)) return cocinaPausada(ctx);
  ctx.datos = { items: [] };
  const notas = [];
  for (const x of anterior.datos.items || []) {
    const producto = catalogo.porGid(x.gid);
    if (!producto) { notas.push(`❌ *${x.nombre}* ya no está en la carta`); continue; }
    notas.push(sumar(ctx, producto, x.gramos ? { gramos: x.gramos } : { cantidad: x.cantidad }).nota);
  }
  if (!ctx.datos.items.length) return responder(ctx, 'armando_pedido', `${notas.join('\n')}\n\nDe lo de la otra vez no queda nada 😕 Decime qué te preparamos, o *0* para cancelar.`);
  return responder(ctx, 'armando_pedido', `¡Dale! Te anoté lo de la última vez (con los precios de hoy):\n${notas.join('\n')}\n\n¿Algo más? Si no, escribí *listo*.`);
}

// La foto del comprobante: va al local con el pedido que se paga por transferencia. Null si no hay uno de las últimas horas.
function comprobante(ctx) {
  const p = qPedidos.ultimoDe(ctx.clienta.id);
  if (!p || p.datos.pago !== 'alias' || !pedidoEnCurso(ctx)) return null;
  const total = (p.datos.items || []).reduce((a, x) => a + subtotal(x), 0) + ((p.datos.entrega && p.datos.entrega.costoEnvioCentavos) || 0);
  return [
    { para: ctx.clienta.telefono, texto: '¡Gracias! 🙌 Le paso el comprobante al local para que lo revise.' },
    { para: ctx.config.numero_duena, imagenRuta: ctx.msj.rutaImagen,
      texto: `💸 *Comprobante de transferencia*\n${ctx.config.textos.cliente_mayuscula}: ${ctx.clienta.nombre || ctx.clienta.telefono} (${ctx.clienta.telefono})\nPedido de ${catalogo.plata(total)}. Revisá que haya llegado.` },
  ];
}

function empezarPedido(ctx) {
  if (!catalogo.cargado()) return sinCatalogo(ctx);
  if (gastro.pausada(ctx.config)) return cocinaPausada(ctx);
  ctx.datos = { items: [] };
  guardarDireccion(ctx, separarDireccion(ctx.msj.texto).direccion);
  if (gastro.esGastro(ctx.config)) {
    return responder(ctx, 'armando_pedido',
      `${encabezadoPedido(ctx)} Decime qué te preparamos y cuántos${ejemploDeLaCarta(ctx, ' (ej: ', ')')}. Si son varias cosas, mandalas juntas, una por renglón.\nCuando termines, escribí *listo*.`);
  }
  return responder(ctx, 'armando_pedido',
    `${encabezadoPedido(ctx)}\nDecime qué querés y cuánto (ej: *2 coca*, *1/4 de jamón*). Podés mandar varias cosas juntas, una por renglón.\nCuando termines, escribí *listo*.`);
}

// El carrito que mandó desde el catálogo de WhatsApp (el adaptador lo lee: `[{ retailerId, nombre, cantidad }]`, o `[]` si no
// pudo). Cada producto del catálogo de WhatsApp lleva como "ID de contenido" (retailer id) el global_id del plato en Nodo Sur;
// si no lo tiene, se busca por el nombre. El precio es el de Nodo Sur, no el que dice WhatsApp: es el que cobra la caja.
function carritoDelCatalogo(ctx) {
  let lineas = Array.isArray(ctx.msj.carrito) ? ctx.msj.carrito : [];
  const deducido = !lineas.length && carritoPorTotal(ctx.msj.carritoResumen);
  if (deducido) lineas = deducido;
  if (!lineas.length) {
    // WhatsApp puede no dar el detalle: con lo que trae el mensaje, al menos se le confirma qué llegó.
    const r = ctx.msj.carritoResumen;
    const vi = r && r.cantidad ? ` (vi ${r.cantidad} ${r.cantidad === 1 ? 'producto' : 'productos'}${r.totalCentavos ? `, ${catalogo.plata(r.totalCentavos)}` : ''})` : '';
    return responder(ctx, ctx.clienta.estado_conv || 'inicio', `Recibí tu carrito${vi}, pero no pude leer el detalle 😅 ¿Me escribís qué querés? (ej: *2 milanesas*)`);
  }
  if (!catalogo.cargado()) return sinCatalogo(ctx);
  if (gastro.pausada(ctx.config)) return cocinaPausada(ctx);
  ctx.datos = { items: [] };
  const notas = [];
  for (const x of lineas.slice(0, MAX_LINEAS)) {
    const cantidad = Math.min(Math.max(Math.trunc(Number(x.cantidad) || 1), 1), 999);
    // El "ID de contenido" del catálogo, si el local le puso el global_id del plato (antes el bot ponía `ns-<global_id>`); si
    // no, se reconoce por el nombre.
    const gid = x.retailerId ? String(x.retailerId).replace(/^ns-/, '') : null;
    let producto = gid ? catalogo.porGid(gid) : null;
    if (!producto && x.nombre) {
      const r = catalogo.buscar(String(x.nombre), 5, sinonimos(ctx)).resultados;
      producto = r.find((y) => nlu.normalizar(y.nombre) === nlu.normalizar(String(x.nombre))) || (r.length === 1 ? r[0] : null);
    }
    if (!producto) { notas.push(`❌ *${x.nombre || 'Un producto'}* no lo tengo en la carta de hoy`); continue; }
    if (catalogo.esPesable(producto)) { notas.push(`⚖️ *${catalogo.nombreCorto(producto)}* va por peso: decime cuánto (ej: *1/2 kilo de ${catalogo.palabrasClave(producto.nombre)[0]}*)`); continue; }
    notas.push(sumar(ctx, producto, { cantidad }).nota);
  }
  if (!ctx.datos.items.length) return responder(ctx, 'armando_pedido', `${notas.join('\n')}\n\nDecime qué querés, o *0* para cancelar.`);
  const r = terminarPedido(ctx);
  r[0].texto = `🛒 Recibí tu carrito:\n${notas.join('\n')}\n\n${r[0].texto}`;
  return r;
}

// Sin el detalle, con cuántos productos y el total que trae el mensaje: la única combinación de la carta que da justo eso
// ("1 producto, $16.000" en una carta con un solo plato de $16.000). Si hay más de una (o ninguna), null: que lo escriba.
const MAX_DEDUCIR = 10;
function carritoPorTotal(resumen) {
  const { cantidad, totalCentavos } = resumen || {};
  if (!catalogo.cargado() || !cantidad || cantidad > MAX_DEDUCIR || !totalCentavos) return null;
  const platos = catalogo.todos().filter((x) => x.hay && !catalogo.esPesable(x) && x.precioCentavos > 0);
  const soluciones = [];
  const elegidos = [];
  (function probar(desde, faltan, plata) {
    if (soluciones.length > 1) return;
    if (!faltan) { if (!plata) soluciones.push([...elegidos]); return; }
    for (let i = desde; i < platos.length; i++) {
      if (platos[i].precioCentavos > plata) continue;
      elegidos.push(platos[i]);
      probar(i, faltan - 1, plata - platos[i].precioCentavos);
      elegidos.pop();
    }
  })(0, cantidad, totalCentavos);
  if (soluciones.length !== 1) return null;
  const porGid = new Map();
  for (const x of soluciones[0]) porGid.set(x.gid, (porGid.get(x.gid) || 0) + 1);
  return [...porGid].map(([gid, n]) => ({ retailerId: gid, nombre: null, cantidad: n }));
}

// La carta: el link del catálogo de WhatsApp si el local lo tiene, y si no, escrita (lo que hay hoy).
const MAX_CARTA = 40;
function carta(ctx) {
  const link = gastro.linkCatalogo(ctx.config);
  if (link) return responder(ctx, 'inicio', `Esta es nuestra carta 👇\n${link}\n\nPodés armar el carrito ahí y mandármelo, o escribime *pedido* y lo anotamos por acá.`);
  if (!catalogo.cargado()) return sinCatalogo(ctx);
  const hay = catalogo.todos().filter((x) => x.hay);
  if (!hay.length) return responder(ctx, 'inicio', 'Hoy ya no nos queda nada para ofrecer 😕 Escribí *4* para hablar con una persona.');
  const lineas = hay.slice(0, MAX_CARTA).map((x) => `• ${nombreConPrecio(x)}`).join('\n');
  const mas = hay.length > MAX_CARTA ? `\n…y ${hay.length - MAX_CARTA} más: preguntame por lo que buscás.` : '';
  return responder(ctx, 'consultando', `Nuestra carta de hoy ${ctx.config.textos.emoji}\n\n${lineas}${mas}\n\nPara pedir, escribí *pedido*.`);
}

// "2 coca", "coca x2", "dos cocas", "un par de alfajores", "media docena de huevos", "coca": cantidad (1 si no dice) y lo
// que busca. Un número que es una medida ("1kg yerba", "2.25 l coca") no es la cantidad. `como` (diccionario/numeros.js)
// dice cómo vino la cantidad (null: no la dijo).
function leerCantidad(texto) {
  const t = texto.trim();
  const medida = catalogo.RE_MEDIDA.source;
  const inicial = !new RegExp(`^${medida}`, 'i').test(t) && numeros.cantidadInicial(t);
  if (inicial) return { cantidad: inicial.cantidad, busqueda: t.slice(t.length - inicial.resto.length), como: inicial.como };
  const m = t.match(/^(.+?)\s*x\s*(\d{1,3})$/i);
  if (m) return { cantidad: Number(m[2]), busqueda: m[1], como: 'numero' };
  return { cantidad: 1, busqueda: t, como: null };
}
const cantidadYProducto = (texto) => { const { cantidad, busqueda } = leerCantidad(texto); return { cantidad, busqueda }; };

// Un renglón del pedido → qué hacer con él. Lo que se pesa y lo que viene en paquete son dos cosas distintas:
//  * PESABLE (el catálogo lo dice: "Jamón cocido (por kg)"): se pide en gramos. "200 de jamón", "1/4 de jamón",
//    "medio de cremoso", "kilo y medio de queso", y "200 jamón" (como en la caja: de 50 para arriba son gramos). Si no dijo
//    cuánto, se pregunta;
//  * EN PAQUETE ("Yerba Playadito 1 kg"): se pide por unidad y no se fracciona. "2 kg de yerba" son 2 paquetes de 1 kg;
//    "medio kilo de yerba" busca el paquete de 500 g y, si no hay, dice que viene en paquete;
//  * "9 de oro", "7up": el número es parte del nombre; "media docena de huevos": primero el paquete de 6.
// Devuelve { tipo, ... }: 'nada' | 'no_encontre' | 'parecidos' (ninguno con todas las palabras, estos con algunas) |
// 'cantidad_mala' | 'paquete' | 'elegir' | 'pesar' | 'anotar'.
function leerLinea(ctx, linea) {
  const sin = sinonimos(ctx);
  const buscar = (t) => catalogo.buscar(t, 5, sin).resultados;
  const peso = numeros.pesoInicial(linea);
  if (peso) {
    const resultados = buscar(peso.resto);
    if (!resultados.length) return { tipo: 'no_encontre', busqueda: peso.resto };
    const pesables = resultados.filter(catalogo.esPesable);
    if (pesables.length === 1) return { tipo: 'anotar', producto: pesables[0], gramos: peso.gramos };
    if (pesables.length > 1) return { tipo: 'elegir', resultados: pesables, cantidad: 1, gramos: peso.gramos };
    const justo = resultados.filter((x) => catalogo.gramosPorUnidad(x) === peso.gramos);
    if (justo.length === 1) return { tipo: 'anotar', producto: justo[0], cantidad: 1 };
    if (justo.length > 1) return { tipo: 'elegir', resultados: justo, cantidad: 1 };
    const entran = resultados.filter((x) => catalogo.gramosPorUnidad(x) && peso.gramos % catalogo.gramosPorUnidad(x) === 0);
    if (entran.length === 1) return { tipo: 'anotar', producto: entran[0], cantidad: peso.gramos / catalogo.gramosPorUnidad(entran[0]) };
    return { tipo: 'paquete', producto: resultados[0] };
  }

  let { cantidad, busqueda, como } = leerCantidad(linea);
  let resultados = null;
  if (como === 'numero') {
    const num = linea.trim().match(/^\d+/);
    const entero = num && buscar(linea);
    if (entero && entero.length && entero.every((x) => catalogo.palabrasClave(x.nombre).includes(num[0]))) {
      ({ cantidad, busqueda, como, resultados } = { cantidad: 1, busqueda: linea.trim(), como: null, resultados: entero });
    }
  }
  if (!resultados && como === 'docena') {
    const paquete = buscar(`${busqueda} ${cantidad}`);
    if (paquete.length) ({ cantidad, resultados } = { cantidad: 1, resultados: paquete });
  }
  if (!catalogo.palabrasClave(busqueda).length) return { tipo: 'nada' };
  // "200 jamón": gramos si es un pesable (como en la caja). Para lo que viene en paquete, la cantidad va hasta 999.
  const gramosDichos = como === 'numero' && cantidad >= 50 ? cantidad : null;
  resultados = resultados || buscar(busqueda);
  if (!resultados.length) {
    const parecidos = catalogo.parecidos(busqueda, 5, sin);
    return parecidos.length ? { tipo: 'parecidos', busqueda, resultados: parecidos, cantidad } : { tipo: 'no_encontre', busqueda };
  }
  // "1 bacon cheese" con Bacon Cheese y Bacon Cheese Doble en la carta: el que se llama justo así, sin preguntar.
  if (resultados.length > 1) {
    const justos = resultados.filter((x) => catalogo.nombreJusto(busqueda, x, sin));
    if (justos.length === 1) resultados = justos;
  }
  if (resultados.length > 1) return { tipo: 'elegir', resultados, cantidad, gramos: gramosDichos };
  const producto = resultados[0];
  if (catalogo.esPesable(producto)) return gramosDichos ? { tipo: 'anotar', producto, gramos: gramosDichos } : { tipo: 'pesar', producto };
  // En un local gastronómico más de 50 de algo en un renglón es un error de tipeo o un evento: que lo hable con el local.
  if (cantidad < 1 || cantidad > (gastro.esGastro(ctx.config) ? 50 : 999)) return { tipo: 'cantidad_mala' };
  return { tipo: 'anotar', producto, cantidad };
}

const TERMINAR = ['listo', 'nada mas', 'eso es todo', 'eso', 'termine', 'ya esta', 'nada', 'no'];

function armando_pedido(ctx) {
  const norm = nlu.normalizar(ctx.texto);
  if (['cancelar', 'cancela', 'cancelo', '0'].includes(norm) || /^(?:quiero |queria )?(?:cancel\w*|anul\w*)(?: el| mi| todo)?(?: pedido)?$/.test(norm)) {
    ctx.datos = {};
    return responder(ctx, 'inicio', 'Listo, no anoté nada. Cuando quieras escribí *hola* 😊');
  }
  // "listo", y también "listo gracias", "eso es todo, gracias".
  if (TERMINAR.includes(norm) || (nlu.esCortesia(ctx.msj.texto || '') && /\b(?:listo|eso es todo|nada mas|ya esta|eso nomas)\b/.test(norm))) return terminarPedido(ctx);
  // "Sacá la bebida", "quitame una empanada": se saca de lo anotado, no se busca como producto (El dueño, 2026-10-23).
  const quitar = norm.match(QUITAR);
  if (quitar) return quitarDelPedido(ctx, norm.slice(quitar[0].length));
  // "Mejor que sean 3", "no, una sola": la cantidad de lo último que anotó.
  const otraCantidad = cambiarCantidad(ctx, norm);
  if (otraCantidad) return otraCantidad;
  // "Para el sábado": el día que lo quiere.
  const diaDicho = anotarDia(ctx);
  if (diaDicho) return responder(ctx, 'armando_pedido', `${diaDicho}\n¿Algo más? Si no, escribí *listo*.`);
  // "Una sin cebolla" después de anotar: aclaración de lo último.
  const suelta = aclaracionSuelta(ctx, ctx.msj.texto || '');
  if (suelta) return responder(ctx, 'armando_pedido', `${suelta}\n¿Algo más? Si no, escribí *listo*.`);
  // "Lo quiero para las 22": queda como aclaración del pedido.
  if (anotarHora(ctx)) return responder(ctx, 'armando_pedido', `🕐 Anotado: lo querés para las ${ctx.datos.hora}.\n¿Algo más? Si no, escribí *listo*.`);
  // Mandó la ubicación mientras arma: es para que se lo lleven ahí.
  const envio = gastro.esGastro(ctx.config) && gastro.formas(ctx.config).find((f) => f.envio);
  if (ctx.msj.ubicacion && envio) {
    ctx.datos.entrega = envio.clave;
    ctx.datos.direccion = direccionDeUbicacion(ctx.msj.ubicacion);
    return responder(ctx, 'armando_pedido', '📍 Anotado: te lo llevamos a esa ubicación.\n¿Algo más? Si no, escribí *listo*.');
  }
  // "¿Cuánto tarda?": lo que dice la cocina ahora.
  const demora = gastro.esGastro(ctx.config) && cuantoTarda(ctx, norm);
  if (demora) return responder(ctx, 'armando_pedido', `${demora}\n¿Algo más? Si no, escribí *listo*.`);
  // Se adelanta ("retiro", "efectivo", "me lo traen?") mientras arma: queda elegido y no se le vuelve a preguntar.
  const adelantado = gastro.esGastro(ctx.config) && adelantarse(ctx, norm);
  if (adelantado) return responder(ctx, 'armando_pedido', `${adelantado}\n¿Algo más? Si no, escribí *listo*.`);
  // "Quería pedirte una doble con papas, dirección De los Satélites 12963": el verbo y la dirección no son el producto.
  const dicho = separarDireccion(ctx.msj.texto);
  guardarDireccion(ctx, dicho.direccion);
  if (dicho.direccion && !dicho.texto.trim()) return responder(ctx, 'armando_pedido', 'Anoté la dirección 🏠 Decime qué te preparamos, o *listo* para terminar.');
  const conVerbo = new RegExp(`^(?:${VERBO_PEDIDO}\\b\\s*)+`);
  const sinVerbo = dicho.texto.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(SALUDO_INICIAL, '');
  let texto = conVerbo.test(sinVerbo) ? sinVerbo.replace(conVerbo, '').replace(RELLENO_FINAL, '') : dicho.texto;
  // "Me olvidé de agregar una coca", "agregame unas papas", "también 2 cocas": lo de adelante no es el producto.
  const agregar_ = /^(?:me olvide(?: de)?(?: agregar| pedir| poner| sumar)?|agrega(?:me|le)?|suma(?:me|le)?|pone(?:me|le)?|tambien|y)\s+/i;
  const sinAgregar = texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (agregar_.test(sinAgregar)) texto = sinAgregar.replace(agregar_, '');
  // "¿tienen cerveza?" mientras arma el pedido es una pregunta, no un renglón: si la contesta una pregunta de siempre o del
  // negocio, se contesta y no se anota nada. Con una cantidad ("¿me sumás 2 cervezas?") sí es un renglón.
  if (esPreguntaSinCantidad(texto)) {
    const aparte = !dicho.direccion && entenderEnPaso(ctx, '¿Algo más? Si no, escribí *listo*.');
    if (aparte) return aparte;
  }
  const lineas = separarLineas(texto);
  if (lineas.length > 1) return anotarVarias(ctx, lineas, []);

  const r = leerConAclaracion(ctx, texto);
  // "¿Tienen bebida?" sin una respuesta cargada: se muestran las que hay y elige él. Una pregunta nunca anota sola (antes
  // anotaba lo único que encontraba, El dueño, 2026-10-23).
  if (r.tipo === 'anotar' && esPreguntaSinCantidad(texto)) return preguntarCual(ctx, [r.producto], 1, ['Sí, tenemos 🙂']);
  if (r.tipo === 'no_encontre' || r.tipo === 'parecidos') {
    // No es un producto: ¿es una pregunta de siempre ("¿hacen envíos?", "¿hasta qué hora están?")? Se contesta sin perder
    // lo anotado. Va después de buscar en el catálogo, así una palabra de un producto nunca se confunde con una pregunta.
    const aparte = !dicho.direccion && entenderEnPaso(ctx, '¿Algo más? Si no, escribí *listo*.');
    if (aparte) return aparte;
    // "jamón y queso": dos productos, si cada uno existe por separado.
    const partes = texto.split(/\s+y\s+/i);
    if (partes.length > 1 && partes.every((x) => !['no_encontre', 'parecidos', 'nada'].includes(leerLinea(ctx, x).tipo))) return anotarVarias(ctx, partes, []);
    if (r.tipo === 'parecidos') return preguntarCual(ctx, r.resultados, r.cantidad, [noJustoAsi(r.busqueda)]);
    anotarNoEntendido(ctx);
    return responder(ctx, 'armando_pedido', `No encontré "${r.busqueda.trim()}" 🤔 ${mirarCarta(ctx)}Probá con otro nombre, o *listo* para terminar.`);
  }
  if (r.tipo === 'nada') return noEntendi(ctx, 'Decime qué producto querés (ej: *2 coca*), o *listo* para terminar.');
  if (r.tipo === 'cantidad_mala') return responder(ctx, 'armando_pedido', cantidadMala(ctx));
  if (r.tipo === 'paquete') return responder(ctx, 'armando_pedido', `${textoPaquete(r.producto)} ¿Cuántos querés? (ej: *1 ${catalogo.palabrasClave(r.producto.nombre)[0]}*)`);
  if (r.tipo === 'pesar') return preguntarPeso(ctx, r.producto, []);
  if (r.tipo === 'elegir') return preguntarCual(ctx, r.resultados, r.cantidad, [], r.gramos, r.nota);
  return agregar(ctx, r.producto, r);
}

// "¿Cuánto tarda?", "¿en cuánto está?": según la cocina y el horario (`cuandoSale`), sin entrega. Null si no pregunta eso.
function cuantoTarda(ctx, norm) {
  if (!/\b(?:cuanto (?:tarda|tardan|demora|demoran|sale|esta)|en cuanto (?:sale|esta|lo tienen)|demora|tardan mucho|cuanto tiempo)\b/.test(norm) || /\b(?:sale|cuesta|vale|precio)\b.*\b(?:la|el|una|un)\b/.test(norm)) return null;
  const sale = gastro.cuandoSale(ctx.config, gastro.FORMAS.RETIRO, null);
  if (!sale) return '😕 Ahora la cocina no está tomando pedidos.';
  if (sale.programado) return `🗓️ Ahora estamos cerrados: lo que pidas sale ${textoDia(sale.hora)}.`;
  return '🛵 Depende de cuántos pedidos haya en la cocina: te aviso por acá apenas salga el tuyo.';
}

// "Retiro", "paso a buscarlo", "a domicilio", "efectivo", "transferencia": lo que va a contestar más adelante. Solo el
// mensaje entero (un renglón con un producto sigue siendo un producto). Devuelve qué anotó, o null.
function adelantarse(ctx, norm) {
  const formas = gastro.formas(ctx.config);
  const retiro = formas.find((f) => !f.envio);
  const envio = formas.find((f) => f.envio);
  if (retiro && /^(?:retiro|lo retiro|retiro yo|paso a (?:buscar|retirar)\w*|lo paso a buscar|lo busco|voy a buscarlo|para retirar)$/.test(norm)) {
    ctx.datos.entrega = retiro.clave;
    return '👍 Anotado: lo retirás en el local.';
  }
  if (envio && /^(?:envio|con envio|a domicilio|delivery|que me lo traigan|me lo traen|traemelo|llevamelo|para enviar)$/.test(norm)) {
    ctx.datos.entrega = envio.clave;
    return '🛵 Anotado: te lo llevamos. Al terminar te pido la dirección.';
  }
  const pagos = gastro.pagos(ctx.config);
  if (/^(?:efectivo|en efectivo|pago en efectivo|pago al recibir|al recibir|pago cuando llega|cash)$/.test(norm) && pagos.includes('al_entregar')) {
    ctx.datos.pago = 'al_entregar';
    return '💵 Anotado: pagás al recibir.';
  }
  if (/^(?:transferencia|por transferencia|transfiero|te transfiero|pago por transferencia)$/.test(norm) && pagos.includes('alias')) {
    ctx.datos.pago = 'alias';
    return '🏦 Anotado: pagás por transferencia (al confirmar te paso el alias).';
  }
  return null;
}

// "Una doble sin cebolla", "1 simple bien cocida": lo que va después es una aclaración para la cocina, no parte del nombre.
// Primero se busca el renglón entero ("Agua sin gas" es un producto); si así no está, se separa la aclaración.
const ACLARACION = /^(.*?\S)\s+(?:pero\s+)?((?:sin|bien|poco|poca|muy|jugos[ao]s?|a punto|vuelta y vuelta|aparte|separad[ao]s?|cortad[ao]s?|con poc[ao]|con much[ao]|con extra|extra|doble (?:cheddar|queso|carne))\b.*)$/i;
function leerConAclaracion(ctx, linea) {
  const r = leerLinea(ctx, linea);
  if (!['no_encontre', 'parecidos'].includes(r.tipo)) return r;
  const m = String(linea).match(ACLARACION);
  if (!m) return r;
  const base = leerLinea(ctx, m[1]);
  if (['no_encontre', 'parecidos', 'nada'].includes(base.tipo)) return r;
  return { ...base, nota: m[2].trim().slice(0, 120) };
}

// "Una sin cebolla", "las dos bien cocidas", "sin cheddar": una aclaración sin producto va con lo último que anotó. Devuelve
// cómo se anotó, o null si no es eso (o no hay nada anotado todavía).
const ACLARACION_SUELTA = /^(?:(?:una|uno|1|una de las|uno de los|las dos|los dos|ambas|ambos|todas|todos)\s+)?(?:pero\s+)?(?:sin|bien|poco|poca|muy|jugos[ao]s?|a punto|vuelta y vuelta|aparte|separad[ao]s?|cortad[ao]s?|con poc[ao]|con much[ao])\b/i;
function aclaracionSuelta(ctx, linea) {
  const items = ctx.datos.items || [];
  const ultimo = items[items.length - 1];
  const t = String(linea).trim();
  if (!ultimo || !ACLARACION_SUELTA.test(nlu.normalizar(t))) return null;
  if (!['no_encontre', 'parecidos', 'nada'].includes(leerLinea(ctx, t).tipo)) return null; // "Agua sin gas" es un producto
  const nota = `${sinDescripcion(ultimo.nombre)}: ${t.slice(0, 120)}`;
  ctx.datos.aclaraciones = [...(ctx.datos.aclaraciones || []), nota].slice(-10);
  return `📝 ${nota}`;
}

// "Mejor que sean 3", "que sean 2", "ponele 4", "no, una sola", "solo 1": cambia la cantidad del último renglón.
function cambiarCantidad(ctx, norm) {
  const m = norm.match(/^(?:no\s+)?(?:mejor\s+)?(?:que sean|que sea|ponele|pone|poneme|cambialo a|cambia a|dejalo en|solo|solamente|son)\s+(.+)$/)
    || norm.match(/^(?:no\s+)?(?:mejor\s+)?(\S+)\s+(?:sola|solo|solas|solos|nomas|nada mas)$/);
  if (!m) return null;
  const n = /^\d+$/.test(m[1].trim()) ? Number(m[1].trim()) : (numeros.cantidadInicial(`${m[1].trim()} x`) || {}).cantidad;
  const items = ctx.datos.items || [];
  const ultimo = items[items.length - 1];
  if (!n || !ultimo || ultimo.gramos) return null;
  if (n > 99) return responder(ctx, 'armando_pedido', 'Esa cantidad no la puedo anotar 😅 Probá de nuevo (ej: *que sean 3*).');
  ultimo.cantidad = n;
  return responder(ctx, 'armando_pedido', `Listo, cambié: ${cuantoDe(ultimo)} — ${catalogo.plata(subtotal(ultimo))} ✍️\n¿Algo más? Si no, escribí *listo*.`);
}

// "Lo quiero para las 22", "para las 21:30": la hora que pide queda en el pedido (la cocina la ve en la nota). True si la anotó.
function anotarHora(ctx) {
  const m = nlu.normalizar(ctx.msj.texto || '').replace(/(\d) (\d{2})\b/, '$1:$2').match(/\b(?:para|a) (?:las?|eso de las?) (\d{1,2})(?::(\d{2}))?\s*(?:hs?|horas|hrs)?\b/);
  if (!m || !gastro.esGastro(ctx.config)) return false;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return false;
  ctx.datos.hora = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  return true;
}

const QUITAR = /^(?:no\s+)?(?:me\s+)?(?:saca|sacame|sacale|sacar|quita|quitame|quitale|quitar|borra|borrame|borrar|elimina|eliminame|cancela(?=\s+(?:el|la|los|las|lo|un|una|\d)\b)|ya no quiero|no quiero (?:mas )?(?:el|la|los|las))\b\s*/;

// Saca de lo anotado lo que nombra [resto] ("la bebida", "una empanada", "eso"): cada renglón cuyo producto aparece al
// buscar esas palabras en la carta, o que las tiene en el nombre. Con una cantidad menor a la anotada, solo baja la cantidad.
function quitarDelPedido(ctx, resto) {
  const items = ctx.datos.items || [];
  if (!items.length) return responder(ctx, 'armando_pedido', 'Todavía no anotaste nada 😅 Decime qué querés, o *0* para cancelar.');
  if (/^(?:todo|toda|todos|todas|todo el pedido|todo lo anotado|lo que anote)$/.test(resto.trim())) {
    ctx.datos.items = [];
    return responder(ctx, 'armando_pedido', '➖ Saqué todo. Decime qué te preparamos, o *0* para cancelar.');
  }
  const { cantidad, busqueda, como } = leerCantidad(resto);
  const palabras = catalogo.palabrasClave(busqueda.replace(/^(?:el|la|los|las|lo|eso|esa|ese|ultimo|ultima)\b\s*/, ''));
  let elegidos;
  if (!palabras.length) elegidos = [items[items.length - 1]]; // "sacá eso", "borrá lo último"
  else {
    const gids = new Set(catalogo.buscar(palabras.join(' '), 20, sinonimos(ctx)).resultados.map((x) => x.gid));
    elegidos = items.filter((x) => gids.has(x.gid) || palabras.every((w) => catalogo.palabrasClave(x.nombre).includes(w)));
  }
  if (!elegidos.length) {
    const lista = items.map((x) => `• ${cuantoDe(x)}`).join('\n');
    return responder(ctx, 'armando_pedido', `No tenés anotado "${busqueda.trim()}" 🤔 Lo que tenés:\n${lista}\n\nDecime cuál saco, o *listo* para terminar.`);
  }
  const notas = [];
  for (const x of elegidos) {
    if (como && elegidos.length === 1 && !x.gramos && cantidad < x.cantidad) {
      x.cantidad -= cantidad;
      notas.push(`➖ Saqué ${cantidad} × ${x.nombre} (quedan ${x.cantidad})`);
    } else {
      items.splice(items.indexOf(x), 1);
      notas.push(`➖ Saqué ${cuantoDe(x)}`);
    }
  }
  ctx.datos.items = items;
  if (!items.length) return responder(ctx, 'armando_pedido', `${notas.join('\n')}\n\nNo te queda nada anotado. Decime qué querés, o *0* para cancelar.`);
  return responder(ctx, 'armando_pedido', `${notas.join('\n')}\n\n¿Algo más? Si no, escribí *listo*.`);
}

const cantidadMala = (ctx) => (gastro.esGastro(ctx.config)
  ? 'Esa cantidad no la puedo anotar 😅 Si es un pedido grande, escribí *4* y lo hablás con el local; si no, probá de nuevo (ej: *2 coca*).'
  : 'Esa cantidad no la puedo anotar 😅 Probá de nuevo (ej: *2 coca*).');

const noJustoAsi = (busqueda) => `🤔 No tengo "${busqueda.trim()}" con ese nombre.`;
// En un local gastronómico, el link de la carta ayuda a encontrar el nombre (si lo tiene).
function mirarCarta(ctx) {
  const link = gastro.esGastro(ctx.config) && gastro.linkCatalogo(ctx.config);
  return link ? `Fijate el nombre en la carta: ${link}\n` : '';
}

const INTERROGATIVO = /^(?:que|cual|cuales|como|cuanto|cuanta|cuantos|cuantas|donde|cuando|tienen|tenes|tienes|hay|hacen|puedo|se puede|podes|es|son|viene|vienen|trae|traen|incluye|sos)\b/;
function esPreguntaSinCantidad(texto) {
  const norm = nlu.normalizar(texto);
  if (!norm || numeros.pesoInicial(norm) || numeros.cantidadInicial(norm) || /\d/.test(norm)) return false;
  return texto.includes('?') || INTERROGATIVO.test(norm);
}

const textoPaquete = (p) => `*${p.nombre}* viene en paquete, no se vende suelto 📦`;

// Varios productos en un mensaje: uno por renglón, o separados por coma ("2 yerba, 1 coca"). La coma entre dos números
// es de una medida ("2,25 L") y no separa. También "un fernet y 2 cocas": la "y" separa solo si sigue una cantidad o un
// peso ("jamón y queso" se prueba aparte, si no hay un producto que se llame así).
const ANTES_DE_CANTIDAD = new RegExp(`(?<!\\b(?:kilo|kilos|kg))\\s+y\\s+(?=\\d|1/|(?:un cuarto|medio|media|un par|${Object.keys(numeros.PALABRAS).join('|')})\\b)`, 'i');
function separarLineas(texto) {
  return texto.split(/\n|,(?!\d)|(?<!\d),/).flatMap((x) => x.split(ANTES_DE_CANTIDAD)).map((x) => x.trim()).filter(Boolean);
}

// Anota cada renglón y junta en un solo mensaje lo anotado y lo que no se pudo. Si uno tiene varias opciones o es un
// pesable sin cantidad, pregunta y guarda el resto (`pendientes`) para seguir apenas conteste.
function anotarVarias(ctx, lineas, notas) {
  const resto = [...lineas];
  while (resto.length) {
    const linea = resto.shift();
    // "2 especiales, una sin cebolla": la aclaración suelta es de lo anterior, no un producto.
    const suelta = aclaracionSuelta(ctx, linea);
    if (suelta) { notas.push(suelta); continue; }
    const r = leerConAclaracion(ctx, linea);
    if (r.tipo === 'nada') continue;
    if (r.tipo === 'cantidad_mala') notas.push(`❌ "${linea}": esa cantidad no la puedo anotar`);
    else if (r.tipo === 'no_encontre') { notas.push(`❌ No encontré "${r.busqueda.trim()}"`); anotarNoEntendido({ ...ctx, msj: { texto: linea } }); }
    else if (r.tipo === 'paquete') notas.push(`📦 ${textoPaquete(r.producto)}: decime cuántos`);
    else if (r.tipo === 'anotar') notas.push(sumar(ctx, r.producto, r).nota);
    else if (r.tipo === 'parecidos') {
      ctx.datos.pendientes = resto;
      return preguntarCual(ctx, r.resultados, r.cantidad, [...notas, noJustoAsi(r.busqueda)]);
    } else {
      ctx.datos.pendientes = resto;
      return r.tipo === 'pesar' ? preguntarPeso(ctx, r.producto, notas) : preguntarCual(ctx, r.resultados, r.cantidad, notas, r.gramos, r.nota);
    }
  }
  delete ctx.datos.pendientes;
  if (!notas.length) return noEntendi(ctx, 'Decime qué producto querés (ej: *2 coca*), o *listo* para terminar.');
  return responder(ctx, 'armando_pedido', `${notas.join('\n')}\n\n¿Algo más? Si no, escribí *listo*.`);
}

// Sigue con lo que quedaba de un mensaje con varios renglones, o espera lo próximo.
function seguir(ctx, notas) {
  const pendientes = ctx.datos.pendientes;
  if (pendientes && pendientes.length) return anotarVarias(ctx, pendientes, notas);
  delete ctx.datos.pendientes;
  if (!notas.length) return responder(ctx, 'armando_pedido', 'Dale, decime qué buscás.');
  return responder(ctx, 'armando_pedido', `${notas.join('\n')}\n\n¿Algo más? Si no, escribí *listo*.`);
}

function preguntarCual(ctx, resultados, cantidad, notas, gramos, nota) {
  ctx.datos.opciones = resultados.map((x) => x.gid);
  ctx.datos.cantidad = cantidad;
  if (nota) ctx.datos.notaPendiente = nota; else delete ctx.datos.notaPendiente;
  if (gramos) ctx.datos.gramos = gramos; else delete ctx.datos.gramos;
  const antes = notas.length ? `${notas.join('\n')}\n\n` : '';
  const lista = resultados.map((x, i) => `*${i + 1}* — ${nombreConPrecio(x)}${x.hay ? '' : ' (sin stock)'}`).join('\n');
  return responder(ctx, 'eligiendo_producto', `${antes}¿Cuál de estos?\n\n${lista}\n\nRespondé con el número, o *0* para buscar otro.`);
}

const ORDINALES = { primera: 1, primero: 1, primer: 1, segunda: 2, segundo: 2, tercera: 3, tercero: 3, cuarta: 4, cuarto: 4, quinta: 5, quinto: 5, ultima: -1, ultimo: -1 };

// "¿Cuál de estos?". Antes, todo lo que no fuera un número contaba como no entender y a la tercera lo pasaba a una persona: el
// bot se callaba con el pedido a medias (El dueño, 2026-10-23). Ahora se elige también por el nombre ("la hamburguesa") o el
// orden ("la primera"); "listo" vuelve a preguntar; y cualquier otra cosa deja la pregunta y se atiende como un renglón nuevo.
function eligiendo_producto(ctx) {
  const limpiar = () => { delete ctx.datos.opciones; delete ctx.datos.cantidad; delete ctx.datos.gramos; delete ctx.datos.notaPendiente; };
  const opciones = (ctx.datos.opciones || []).map(catalogo.porGid).filter(Boolean);
  if (ctx.texto === '0') { limpiar(); return seguir(ctx, []); }
  const norm = nlu.normalizar(ctx.texto);
  // Solo el número ("2", "el 2", "opción 2") es elegir: "1 simple bien cocida" es un renglón nuevo, no la opción 1.
  const n = /^(?:el|la|opcion|numero|nro)?\s*\d{1,2}$/.test(norm) ? numerosDe(ctx.texto)[0] : null;
  let producto = n ? opciones[n - 1] : null;
  if (!producto) {
    const ord = norm.split(' ').map((w) => ORDINALES[w]).find(Boolean);
    if (ord) producto = opciones[ord === -1 ? opciones.length - 1 : ord - 1];
  }
  if (!producto && norm) {
    const palabras = catalogo.palabrasClave(norm);
    const calzan = palabras.length ? opciones.filter((x) => palabras.every((w) => nlu.normalizar(x.nombre).split(' ').some((t) => t.startsWith(w) || w.startsWith(t)))) : [];
    if (calzan.length === 1) [producto] = calzan;
  }
  if (!producto) {
    const lista = opciones.map((x, i) => `*${i + 1}* — ${nombreConPrecio(x)}`).join('\n');
    // "No", "no gracias": no va ninguno.
    if (/^no\b/.test(norm)) { limpiar(); return seguir(ctx, []); }
    if (TERMINAR.includes(norm) || nlu.esSi(ctx.texto) || nlu.esCortesia(ctx.texto)) {
      // A la segunda, no se insiste: se deja sin anotar y, si dijo "listo", se termina con lo que hay.
      if (ctx.datos.yaPregunte) {
        delete ctx.datos.yaPregunte; limpiar(); delete ctx.datos.pendientes;
        if (TERMINAR.includes(norm) && (ctx.datos.items || []).length) return conNota(terminarPedido(ctx), 'Dale, eso no lo anoté.');
        return responder(ctx, 'armando_pedido', 'Dale, eso no lo anoté. Decime qué querés, o *listo* para terminar.');
      }
      ctx.datos.yaPregunte = true;
      return responder(ctx, 'eligiendo_producto', `Antes decime cuál querés:\n\n${lista}\n\nRespondé con el número, o *0* si no va.`);
    }
    // Otra cosa ("una coca", "¿hacen envíos?", "sacá la doble"): la pregunta queda sin contestar y se sigue armando, avisando
    // que lo anterior no se anotó (si no, creería que sí).
    const anterior = opciones[0] ? catalogo.palabrasClave(opciones[0].nombre).slice(-1)[0] : null;
    limpiar();
    delete ctx.datos.yaPregunte;
    ctx.clienta.estado_conv = 'armando_pedido';
    return conNota(armando_pedido(ctx), anterior ? `(Lo de antes quedó sin anotar: si lo querés, pedímelo de nuevo con el nombre completo.)` : null);
  }
  const { cantidad = 1, gramos, notaPendiente } = ctx.datos;
  limpiar();
  delete ctx.datos.yaPregunte;
  if (catalogo.esPesable(producto) && !gramos) return preguntarPeso(ctx, producto, []);
  if (!catalogo.esPesable(producto) && gastro.esGastro(ctx.config) && cantidad > 50) return responder(ctx, 'armando_pedido', cantidadMala(ctx));
  const pedido = catalogo.esPesable(producto) ? { gramos } : { cantidad: Math.min(cantidad, 999) };
  if (notaPendiente) pedido.nota = notaPendiente;
  if (ctx.datos.pendientes) return anotarVarias(ctx, ctx.datos.pendientes, [sumar(ctx, producto, pedido).nota]);
  return agregar(ctx, producto, pedido);
}

// Un pesable sin cantidad ("jamón cocido"): ¿cuánto?
function preguntarPeso(ctx, producto, notas) {
  if (!producto.hay) return seguir(ctx, [...notas, `❌ No hay *${catalogo.nombreCorto(producto)}* ahora 😕`]);
  ctx.datos.pesar = producto.gid;
  const antes = notas.length ? `${notas.join('\n')}\n\n` : '';
  return responder(ctx, 'eligiendo_peso',
    `${antes}¿Cuánto *${catalogo.nombreCorto(producto)}* querés? Está ${catalogo.plata(producto.precioCentavos)} el kilo ⚖️\n(ej: *200 g*, *1/4*, *medio*, *1 kilo*; o *0* si no va)`);
}

function eligiendo_peso(ctx) {
  const producto = catalogo.porGid(ctx.datos.pesar);
  delete ctx.datos.pesar;
  if (ctx.texto === '0' || !producto) return seguir(ctx, []);
  const gramos = numeros.pesoSuelto(ctx.msj.texto || '');
  if (!gramos) {
    ctx.datos.pesar = producto.gid;
    return noEntendi(ctx, `Decime cuánto *${catalogo.nombreCorto(producto)}*: *200 g*, *1/4*, *medio*, *1 kilo*… (o *0* si no va)`);
  }
  if (ctx.datos.pendientes) return anotarVarias(ctx, ctx.datos.pendientes, [sumar(ctx, producto, { gramos }).nota]);
  return agregar(ctx, producto, { gramos });
}

// Cómo se nombra cada cosa: "2 × Coca Cola 2,25 L" o "250 g de Jamón cocido Paladini"; y lo que sale.
const nombreConPrecio = (x) => (catalogo.esPesable(x)
  ? `${catalogo.nombreCorto(x)} — ${catalogo.plata(x.precioCentavos)} el kilo`
  : `${x.nombre} — ${catalogo.plata(x.precioCentavos)}`);
// El nombre sin lo de entre paréntesis ("Especial (doble medallón, …)" → "Especial"): el renglón del pedido se lee de un vistazo.
const sinDescripcion = (nombre) => String(nombre).replace(/\s*\((?!\s*por kg)[^)]*\)\s*$/i, '').trim() || String(nombre);
const cuantoDe = (x) => (x.gramos ? `${numeros.textoPeso(x.gramos)} de ${catalogo.nombreCorto(x)}` : `${x.cantidad} × ${sinDescripcion(x.nombre)}`);
const subtotal = (x) => (x.gramos ? catalogo.precioDeGramos(x.precioCentavos, x.gramos) : x.precioCentavos * x.cantidad);

// Suma el producto al pedido (si hay stock y entra): { cantidad } por unidad o { gramos } si se pesa. Devuelve si se
// anotó y la línea para contarlo.
function sumar(ctx, producto, { cantidad, gramos, nota }) {
  if (!producto.hay) return { ok: false, nota: `❌ No hay stock de *${catalogo.esPesable(producto) ? catalogo.nombreCorto(producto) : producto.nombre}* ahora 😕` };
  const items = ctx.datos.items || [];
  const nuevo = gramos
    ? { gid: producto.gid, nombre: producto.nombre, gramos, precioCentavos: producto.precioCentavos }
    : { gid: producto.gid, nombre: sinDescripcion(producto.nombre), cantidad, precioCentavos: producto.precioCentavos };
  const ya = items.find((x) => x.gid === producto.gid && !!x.gramos === !!gramos);
  if (ya && gramos) ya.gramos = Math.min(50000, ya.gramos + gramos);
  else if (ya) ya.cantidad = Math.min(999, ya.cantidad + cantidad);
  else {
    if (items.length >= MAX_LINEAS) return { ok: false, lleno: true, nota: `❌ Ya es un pedido grande 😅 No anoté *${producto.nombre}*.` };
    items.push(nuevo);
  }
  ctx.datos.items = items;
  // La aclaración ("sin cebolla") viaja en la nota del pedido, que la app muestra a la cocina.
  if (nota) ctx.datos.aclaraciones = [...(ctx.datos.aclaraciones || []), `${sinDescripcion(producto.nombre)}: ${nota}`].slice(-10);
  return { ok: true, nota: `✍️ ${cuantoDe(nuevo)} — ${catalogo.plata(subtotal(nuevo))}${gramos ? ' aprox. ⚖️' : ''}${nota ? ` (${nota})` : ''}` };
}

function agregar(ctx, producto, pedido) {
  const r = sumar(ctx, producto, pedido);
  if (!r.ok) {
    return responder(ctx, 'armando_pedido', r.lleno
      ? 'Ya es un pedido grande 😅 Escribí *listo* para mandarlo.'
      : `${r.nota.replace(/^❌ /, '')} ¿Querés algo más? Si no, escribí *listo*.`);
  }
  return responder(ctx, 'armando_pedido', `Anotado: ${r.nota.replace(/^✍️ /, '')} ✍️\n¿Algo más? Si no, escribí *listo*.`);
}

function terminarPedido(ctx) {
  if (!(ctx.datos.items || []).length) {
    return responder(ctx, 'armando_pedido', 'Todavía no anotaste nada 😅 Decime qué querés (ej: *2 coca*), o *0* para cancelar.');
  }
  if (gastro.esGastro(ctx.config)) return siguienteGastro(ctx);
  if (!ctx.clienta.nombre) return responder(ctx, 'pidiendo_nombre', '¿A nombre de quién lo preparamos?');
  return resumen(ctx);
}

// ---------- local gastronómico: entrega, dirección, zona, nombre y pago ----------
// Pregunta lo primero que falta; con todo, el resumen. Lo que tiene una sola opción no se pregunta.
function siguienteGastro(ctx) {
  const c = ctx.config;
  const d = ctx.datos;
  const formas = gastro.formas(c);
  if (!d.entrega && formas.length === 1) d.entrega = formas[0].clave;
  if (!d.entrega) {
    const lista = formas.map((f, i) => `*${i + 1}* — ${f.texto}`).join('\n');
    return responder(ctx, 'eligiendo_entrega', `¿Cómo lo querés?\n\n${lista}`);
  }
  const forma = gastro.FORMAS[d.entrega];
  if (forma.envio && !d.direccion) return responder(ctx, 'pidiendo_direccion', '¿A qué dirección te lo llevamos? 🏠 (calle, número y algún dato para encontrarte)');
  const zs = gastro.zonas(c);
  if (forma.envio && !d.zona) {
    if (zs.length <= 1) d.zona = zs.length ? zs[0].nombre : 'General';
    else {
      const lista = zs.map((z, i) => `*${i + 1}* — ${z.nombre} (envío ${precioEnvio(gastro.costoEnvio(forma, z))})`).join('\n');
      return responder(ctx, 'eligiendo_zona', `¿En qué zona estás?\n\n${lista}`);
    }
  }
  if (!ctx.clienta.nombre) return responder(ctx, 'pidiendo_nombre', '¿A nombre de quién lo preparamos?');
  const pagos = gastro.pagos(c);
  if (!d.pago && pagos.length === 1) d.pago = pagos[0];
  if (!d.pago) {
    const lista = pagos.map((p, i) => `*${i + 1}* — ${gastro.TEXTO_PAGO[p]}`).join('\n');
    return responder(ctx, 'eligiendo_pago', `¿Cómo pagás?\n\n${lista}`);
  }
  // Hoy no hay entregas: que elija el día (El dueño, 2026-10-23), en vez de programarlo solo para el primero que abre.
  if (!d.dia) {
    const zona = forma.envio ? zs.find((z) => z.nombre === d.zona) || null : null;
    const ahora = gastro.cuandoSale(c, forma, zona);
    const dias = gastro.proximosDias(c, 3);
    if (ahora && ahora.programado && dias.length > 1) {
      const lista = dias.map((x, i) => `*${i + 1}* — ${fechas.diaLindo(x.ymd)}`).join('\n');
      return responder(ctx, 'eligiendo_dia', `🗓️ Hoy no hacemos ${forma.envio ? 'envíos' : 'entregas'}. ¿Para qué día lo querés?\n\n${lista}`);
    }
  }
  return resumen(ctx);
}

const cancelar = (ctx) => { ctx.datos = {}; return responder(ctx, 'inicio', 'Listo, no anoté nada. Cuando quieras escribí *hola* 😊'); };

// Elegir de una lista numerada (o por la palabra: "retiro", "envío", el nombre de la zona).
function elegir(ctx, cantidad, porTexto) {
  if (ctx.texto === '0') return { cancelar: true };
  const n = nlu.opcionMenu(ctx.texto) || numerosDe(ctx.texto)[0];
  if (n >= 1 && n <= cantidad) return { i: n - 1 };
  const i = porTexto ? porTexto(nlu.normalizar(ctx.texto)) : -1;
  return i >= 0 ? { i } : {};
}

function eligiendo_entrega(ctx) {
  const formas = gastro.formas(ctx.config);
  // Mandó la ubicación: quiere que se lo lleven, y esa es la dirección.
  const envio = formas.find((f) => f.envio);
  if (ctx.msj.ubicacion && envio) {
    ctx.datos.entrega = envio.clave;
    ctx.datos.direccion = direccionDeUbicacion(ctx.msj.ubicacion);
    return siguienteGastro(ctx);
  }
  if (anotarHora(ctx)) return conNota(siguienteGastro(ctx), `🕐 Anotado: lo querés para las ${ctx.datos.hora}.`);
  const r = elegir(ctx, formas.length, (t) => formas.findIndex((f) => (f.envio
    ? /\b(?:envio|enviar|envialo|traer|traigan|traen|llevar|lleven|delivery|domicilio|casa)\b/.test(t)
    : /\b(?:retiro|retirar|retira|busco|buscar|paso|local)\b/.test(t))));
  if (r.cancelar) return cancelar(ctx);
  if (r.i === undefined) return noEntendi(ctx, 'Respondé con el número de la lista, o *0* para cancelar.');
  ctx.datos.entrega = formas[r.i].clave;
  return siguienteGastro(ctx);
}

// La ubicación compartida, como dirección: el link del mapa (con el nombre o la dirección, si WhatsApp los manda).
const direccionDeUbicacion = (u) => `${[u.nombre, u.direccion].filter(Boolean).join(', ') || 'Ubicación'} 📍 https://maps.google.com/?q=${u.lat},${u.lng}`;

function pidiendo_direccion(ctx) {
  if (ctx.msj.ubicacion) { ctx.datos.direccion = direccionDeUbicacion(ctx.msj.ubicacion); return siguienteGastro(ctx); }
  const dir = (ctx.msj.texto || '').trim();
  if (dir === '0') return cancelar(ctx);
  const norm = nlu.normalizar(dir);
  // "No sé la dirección", "¿cuánto sale el envío?": no es una dirección.
  if (dir.length < 4 || dir.length > 160 || !/[a-zA-ZáéíóúñÑ]/.test(dir) || dir.includes('?') || /^(?:no\b|ni idea|nose\b)/.test(norm)) {
    const tm = temaDe(ctx, ctx.texto);
    if (tm && dir.includes('?')) return conNota(responder(ctx, 'pidiendo_direccion', '¿A qué dirección te lo llevamos? 🏠'), responderTema(ctx, tm, porDefecto(ctx), 'pidiendo_direccion')[0].texto);
    return responder(ctx, 'pidiendo_direccion', 'Necesito la dirección para llevártelo 🏠 (ej: *Mitre 150, timbre B*). También podés mandarme tu *ubicación* 📍, o *0* para cancelar.');
  }
  // Sin la altura el cadete no llega: se pide una vez; si insiste sin número (un barrio, una manzana), vale así.
  if (!/\d/.test(dir) && !ctx.datos.sinAltura) {
    ctx.datos.sinAltura = true;
    return responder(ctx, 'pidiendo_direccion', `¿Me pasás la altura? (ej: *${dir.split(/\s+/)[0]} 150*) Si no tiene número, mandame tu *ubicación* 📍 o escribila de nuevo con alguna seña.`);
  }
  delete ctx.datos.sinAltura;
  ctx.datos.direccion = dir;
  return siguienteGastro(ctx);
}

// "el Sábado 24/10, desde las 19:00" / "hoy, desde las 19:00": el día en que sale un pedido programado, sin prometer la hora.
function textoDia(hora) {
  const abre = gastro.textoHora(hora).replace(/ a las \d{2}:\d{2}$/, '').trim();
  const desde = `${String(hora.getHours()).padStart(2, '0')}:00`;
  return `${abre || 'hoy'}, desde las ${desde}`;
}

// Antepone [nota] al primer mensaje de una respuesta.
function conNota(r, nota) {
  if (r && r[0] && nota) r[0].texto = `${nota}\n\n${r[0].texto}`;
  return r;
}

function eligiendo_zona(ctx) {
  const zs = gastro.zonas(ctx.config);
  const r = elegir(ctx, zs.length, (t) => zs.findIndex((z) => nlu.normalizar(z.nombre) === t));
  if (r.cancelar) return cancelar(ctx);
  if (r.i === undefined) return noEntendi(ctx, 'Respondé con el número de tu zona, o *0* para cancelar.');
  ctx.datos.zona = zs[r.i].nombre;
  return siguienteGastro(ctx);
}

// "Efectivo, llevo 20 mil", "pago con 20000": con cuánto paga, para que el cadete lleve el vuelto.
function anotarVuelto(ctx) {
  const m = nlu.normalizar(ctx.msj.texto || '').replace(/(\d)[.,](\d{3})\b/g, '$1$2').match(/\b(?:con|llevo|tengo|de|pago con|abono con|billete de)\s*(\d{2,6})\s*(mil|k|lucas)?\b/);
  if (!m) return;
  const pesos = Number(m[1]) * (m[2] ? 1000 : 1);
  if (pesos >= 1000 && pesos <= 1000000) ctx.datos.vuelto = pesos * 100;
}

function eligiendo_pago(ctx) {
  const pagos = gastro.pagos(ctx.config);
  if (anotarHora(ctx)) return conNota(siguienteGastro(ctx), `🕐 Anotado: lo querés para las ${ctx.datos.hora}.`);
  const r = elegir(ctx, pagos.length, (t) => pagos.findIndex((p) => ({
    alias: /\b(?:transfiero|transferencia|transferir|alias)\b/,
    mp: /\b(?:mercado ?pago|mp|link|tarjeta)\b/,
    al_entregar: /\b(?:efectivo|recibir|entregar|cuando llegue|al retirar|despues)\b/,
  })[p].test(t)));
  if (r.cancelar) return cancelar(ctx);
  if (r.i === undefined) return noEntendi(ctx, 'Respondé con el número, o *0* para cancelar.');
  ctx.datos.pago = pagos[r.i];
  if (ctx.datos.pago === 'al_entregar') anotarVuelto(ctx);
  return siguienteGastro(ctx);
}

// "El sábado", "2", "viernes": el día que eligió de la lista.
function eligiendo_dia(ctx) {
  const dias = gastro.proximosDias(ctx.config, 3);
  const r = elegir(ctx, dias.length, (t) => dias.findIndex((x) => t.includes(fechas.nombreDia(x.ymd)) || (t.includes('manana') && x.ymd === manianaYmd())));
  if (r.cancelar) return cancelar(ctx);
  if (r.i === undefined) return noEntendi(ctx, 'Respondé con el número del día, o *0* para cancelar.');
  ctx.datos.dia = dias[r.i].ymd;
  return siguienteGastro(ctx);
}
const manianaYmd = () => { const a = fechas.ahora(); return fechas.aTexto(new Date(a.getFullYear(), a.getMonth(), a.getDate() + 1)).slice(0, 10); };

// "Para el sábado", "lo quiero el viernes": el día, si es uno de los que entregan. Devuelve el texto de lo anotado, o null.
function anotarDia(ctx) {
  if (!gastro.esGastro(ctx.config)) return null;
  const t = nlu.normalizar(ctx.msj.texto || '');
  const m = t.match(/\b(?:para|el|lo quiero|seria) (?:el )?(lunes|martes|miercoles|jueves|viernes|sabado|domingo|manana)\b/);
  if (!m) return null;
  const dia = gastro.proximosDias(ctx.config, 7).find((x) => (m[1] === 'manana' ? x.ymd === manianaYmd() : fechas.nombreDia(x.ymd) === m[1]));
  if (!dia) return `😕 Ese día no hacemos ${gastro.formas(ctx.config).some((f) => f.envio) ? 'envíos' : 'entregas'}.`;
  ctx.datos.dia = dia.ymd;
  return `🗓️ Anotado: para el ${fechas.diaLindo(dia.ymd)}.`;
}

// Cuándo sale este pedido: el día que eligió, o lo primero que se pueda.
function saleDelPedido(ctx, forma, zona) {
  if (ctx.datos.dia) return gastro.saleElDia(ctx.config, forma, zona, ctx.datos.dia) || gastro.cuandoSale(ctx.config, forma, zona);
  return gastro.cuandoSale(ctx.config, forma, zona);
}

// Lo de la entrega que va al pedido y al resumen: la forma, la zona elegida y lo que sale el envío.
function entregaDe(ctx) {
  const forma = gastro.FORMAS[ctx.datos.entrega] || gastro.FORMAS.RETIRO;
  const zona = forma.envio ? gastro.zonas(ctx.config).find((z) => z.nombre === ctx.datos.zona) || null : null;
  return { forma, zona, costo: gastro.costoEnvio(forma, zona) };
}

function pidiendo_nombre(ctx) {
  // "Soy Pedro", "a nombre de Juan Pérez": el nombre, sin la frase.
  const nombre = (ctx.msj.texto || '').trim().replace(/^(?:hola[,!.\s]+)?(?:soy|me llamo|mi nombre es|a nombre de|es para|para|ponele|pone)\s+/i, '').replace(/[.!\s]+$/, '');
  if (nombre === '0') { ctx.datos = {}; return responder(ctx, 'inicio', 'Listo, no anoté nada. Cuando quieras escribí *hola* 😊'); }
  const letras = (nombre.match(/[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ]/g) || []).length;
  if (nombre.includes('?') || letras < 2 || nombre.length > 40) {
    return responder(ctx, 'pidiendo_nombre', 'Necesito un nombre para preparar el pedido 😊 (o *0* para cancelar)');
  }
  qClientas.guardarNombre(ctx.clienta.id, nombre);
  ctx.clienta.nombre = nombre;
  if (gastro.esGastro(ctx.config)) return siguienteGastro(ctx);
  return resumen(ctx);
}

function resumen(ctx) {
  if (gastro.esGastro(ctx.config)) return resumenGastro(ctx);
  const items = ctx.datos.items;
  const total = items.reduce((s, x) => s + subtotal(x), 0);
  const lineas = items.map((x) => `• ${cuantoDe(x)} — ${catalogo.plata(subtotal(x))}`).join('\n');
  const pesado = items.some((x) => x.gramos) ? '\n⚖️ Lo que se pesa puede variar un poco en la balanza.' : '';
  return responder(ctx, 'confirmando_pedido',
    `${ctx.clienta.nombre}, tu pedido:\n\n${lineas}\n\n💰 Total aproximado: ${catalogo.plata(total)}${pesado}\n📍 Lo retirás en el local.\n${AVISO_PRECIO}\n\n*1* — Confirmar\n*2* — Agregar algo más\n*0* — Cancelar`);
}

function resumenGastro(ctx) {
  const items = ctx.datos.items;
  const { forma, costo } = entregaDe(ctx);
  const sale = saleDelPedido(ctx, forma, entregaDe(ctx).zona);
  if (!sale) return cocinaPausada(ctx);
  const total = items.reduce((s, x) => s + subtotal(x), 0) + costo;
  const lineas = items.map((x) => `• ${cuantoDe(x)} — ${catalogo.plata(subtotal(x))}`).join('\n');
  const envio = forma.envio ? `\n🛵 Envío a ${ctx.datos.direccion} (${ctx.datos.zona}) — ${precioEnvio(costo)}` : '';
  const donde = forma.envio ? '' : '\n📍 Lo retirás en el local.';
  // Sin hora prometida (El dueño, 2026-10-23: "en vez de decir cuánto va a tardar, cuando salga el cadete: ya salió tu
  // pedido"): con una plancha y un cadete, cualquier hora falla justo cuando hay más pedidos. Otro día sí: el día y desde cuándo.
  const cuando = sale.programado
    ? `🗓️ ${forma.envio ? 'Llega' : 'Está listo'} ${textoDia(sale.hora)}.`
    : forma.envio ? '🛵 Te avisamos por acá apenas salga.' : '🍽️ Te avisamos por acá apenas esté listo.';
  const pago = { alias: '\n💳 Pagás ahora por transferencia.', mp: '\n💳 Pagás ahora con Mercado Pago (te paso el link).' }[ctx.datos.pago]
    || `\n💵 Pagás al recibir${ctx.datos.vuelto ? ` (con ${catalogo.plata(ctx.datos.vuelto)})` : ''}.`;
  const aclaraciones = notaDelPedido(ctx) ? `\n📝 ${notaDelPedido(ctx)}` : '';
  return responder(ctx, 'confirmando_pedido',
    `${ctx.clienta.nombre}, así quedó tu pedido:\n\n${lineas}${envio}${aclaraciones}\n\n💰 Total: ${catalogo.plata(total)}${donde}\n${cuando}${pago}\n\n¿Te lo confirmo?\n*1* — Sí, confirmar\n*2* — Quiero agregar algo\n*0* — Cancelar\n(También podés escribirme qué cambiar, por ejemplo *sacá ${items[0] && !items[0].gramos ? `la ${sinDescripcion(items[0].nombre).toLowerCase()}` : 'eso'}*)`);
}

// Lo que la cocina tiene que saber y no es un producto: aclaraciones, la hora que pidió y con cuánto paga. Viaja como la nota
// del pedido, que la app ya muestra (`PedidoBot.nota`).
function notaDelPedido(ctx) {
  const d = ctx.datos;
  return [
    ...(d.aclaraciones || []),
    ...(d.hora ? [`Lo quiere para las ${d.hora}`] : []),
    ...(d.vuelto && (d.pago || 'al_entregar') === 'al_entregar' ? [`Paga con ${catalogo.plata(d.vuelto)}`] : []),
  ].join(' · ') || null;
}

// El pedido de un local gastronómico: la hora se vuelve a sacar al confirmar (la cocina pudo cambiar mientras tanto).
function confirmarGastro(ctx) {
  const { forma, zona, costo } = entregaDe(ctx);
  const sale = saleDelPedido(ctx, forma, zona);
  if (!sale) return cocinaPausada(ctx);
  const items = ctx.datos.items;
  qPedidos.crear(ctx.clienta.id, {
    cliente: { nombre: ctx.clienta.nombre, telefono: ctx.clienta.telefono },
    items,
    entrega: { forma: forma.clave, ...(forma.envio ? { direccion: ctx.datos.direccion, zona: ctx.datos.zona, costoEnvioCentavos: costo } : {}) },
    pago: ctx.datos.pago || 'al_entregar',
    ...(notaDelPedido(ctx) ? { nota: notaDelPedido(ctx).slice(0, 500) } : {}),
    horaEstimada: sale.hora.getTime(),
    ...(sale.programado ? { programado: true } : {}),
  });
  const total = items.reduce((s, x) => s + subtotal(x), 0) + costo;
  const pago = ctx.datos.pago;
  ctx.datos = {};
  // Por Mercado Pago el link llega apenas el sitio lo arma (`nube/sincronizar.js`), y el local lo ve cuando se acredita.
  if (pago === 'mp') return responder(ctx, 'inicio', `¡Listo! Ya te paso el link para pagar ${catalogo.plata(total)} 💳 Apenas se acredita, le llega tu pedido al local.`);
  const pagar = pago === 'alias' ? `\n\n${gastro.textoAlias(ctx.config, catalogo.plata(total))}` : '';
  return responder(ctx, 'inicio', `¡Listo, gracias! 🙌 Ya le pasé tu pedido a la cocina. En un ratito te confirmo por acá.${pagar}`);
}

const CONFIRMA = /^(?:si+|sii+|confirmo|confirmar|confirmado|confirma|mandalo|pedilo|ok|oka|okey|okis|dale|dale si|si dale|si confirmo|perfecto|joya|genial|de una|listo|va|vamos|correcto|esta bien|todo bien|asi esta bien)$/;
function confirmando_pedido(ctx) {
  const norm = nlu.normalizar(ctx.texto);
  if (nlu.esSi(ctx.texto) || CONFIRMA.test(norm) || /^[\s👍👌✅🙌]+$/u.test(ctx.msj.texto || '')) ctx.texto = '1';
  if (ctx.texto === '2') return responder(ctx, 'armando_pedido', 'Dale, decime qué más querés.');
  if (ctx.texto === '0' || /^(?:cancelar|cancela|cancelo|no quiero nada|dejalo)$/.test(norm)) { ctx.datos = {}; return responder(ctx, 'inicio', 'Listo, no anoté nada. Cuando quieras escribí *hola* 😊'); }
  if (ctx.texto !== '1' && gastro.esGastro(ctx.config)) {
    const demora = cuantoTarda(ctx, norm);
    if (demora) return conNota(siguienteGastro(ctx), demora);
    const cambio = cambiarEnElResumen(ctx, norm);
    if (cambio) return cambio;
  }
  if (ctx.texto !== '1') return noEntendi(ctx, 'Respondé *1* para confirmar, *2* para agregar algo o *0* para cancelar.');
  if (gastro.esGastro(ctx.config)) return confirmarGastro(ctx);
  qPedidos.crear(ctx.clienta.id, {
    cliente: { nombre: ctx.clienta.nombre, telefono: ctx.clienta.telefono },
    items: ctx.datos.items,
  });
  ctx.datos = {};
  return responder(ctx, 'inicio', '¡Listo! Le pasé tu pedido al local 🙌 Te aviso por acá apenas lo confirmen.');
}

// En el resumen, en vez de 1/2/0: "sacá la coca", "sumá unas papas", "que sean 3", "para las 22", "pago con 20 mil". Se hace el
// cambio y se vuelve a mostrar el resumen. Null si no es nada de eso.
function cambiarEnElResumen(ctx, norm) {
  ctx.clienta.estado_conv = 'armando_pedido';
  const quitar = norm.match(QUITAR);
  let r = null;
  if (quitar) r = quitarDelPedido(ctx, norm.slice(quitar[0].length));
  else if (anotarDia(ctx)) r = [{ texto: anotarDia(ctx) }];
  else if (anotarHora(ctx)) r = [{ texto: `🕐 Anotado: lo querés para las ${ctx.datos.hora}.` }];
  else if (/\b(?:llevo|pago con|abono con|tengo)\b/.test(norm) && (anotarVuelto(ctx), ctx.datos.vuelto)) r = [{ texto: `💵 Anotado: pagás con ${catalogo.plata(ctx.datos.vuelto)}.` }];
  else r = cambiarCantidad(ctx, norm);
  if (!r) {
    const sinVerbo = norm.replace(/^(?:agrega|agregale|agregame|suma|sumale|sumame|y|tambien|ponele|pone|poneme|mandame|quiero)\s+/, '');
    const l = leerConAclaracion(ctx, sinVerbo);
    if (l.tipo === 'anotar') r = [{ texto: sumar(ctx, l.producto, l).nota }];
    else if (l.tipo === 'elegir') return preguntarCual(ctx, l.resultados, l.cantidad, [], l.gramos, l.nota);
  }
  ctx.clienta.estado_conv = 'confirmando_pedido';
  if (!r) return null;
  if (!(ctx.datos.items || []).length) return responder(ctx, 'armando_pedido', 'No te queda nada anotado. Decime qué te preparamos, o *0* para cancelar.');
  const nota = r[0].texto.split('\n\n')[0];
  return conNota(siguienteGastro(ctx), nota);
}

// `ctx.entender` del comercio (ver noEntendi en maquina.js), también al principio de cada renglón del pedido: una risa no
// se contesta, un "gracias" no es no entender, y una pregunta de siempre (envíos, cómo se paga, horarios) o pedir una
// persona se atienden sin perder el paso. Lo demás (null) lo sigue resolviendo el paso.
function entenderEnPaso(ctx, ayuda) {
  const t = ctx.texto;
  const estado = ctx.clienta.estado_conv;
  if (estado === 'inicio' || estado === 'consultando') return null;
  if (!t || nlu.esRisa(t)) return [];
  if (nlu.esCortesia(t)) return responder(ctx, estado, `😊 ${ayuda}`);
  const apurado = apuro(ctx, ayuda);
  if (apurado) return apurado;
  const tm = temaDe(ctx, t);
  if (tm) {
    const r = responderTema(ctx, tm, porDefecto(ctx), estado);
    r[0].texto += `\n\n${ayuda}`;
    return r;
  }
  if (nlu.interpretar(t).intencion === 'humano') return derivarAHumano(ctx, ctx.msj.texto);
  return enojo(ctx);
}

// El mensaje para el cliente cuando el local resolvió o avanzó su pedido en la app. Null si ese paso no se le avisa: un envío
// listo todavía no salió (se avisa al salir) y uno entregado ya lo tiene en la mano (la misma regla que `mensajeAlCliente`
// de la app).
function avisoDePedido(config, pedido, estado) {
  const telefono = pedido.datos.cliente.telefono;
  const entrega = pedido.datos.entrega;
  if (entrega) {
    const envio = entrega.forma !== 'RETIRO';
    const donde = config.negocio.direccion ? `\n📍 ${config.negocio.direccion}` : '';
    const hora = pedido.datos.programado && pedido.datos.horaEstimada ? ` (${textoDia(new Date(pedido.datos.horaEstimada))})` : '';
    const texto = {
      pagado: '💸 ¡Recibimos tu pago! Ya le pasé tu pedido al local; te aviso por acá apenas lo confirmen.',
      aceptado: `✅ ¡Confirmamos tu pedido! Te aviso por acá cuando esté ${envio ? 'en camino' : 'listo'}${hora}.`,
      listo: envio ? null : `🍽️ ¡Tu pedido está listo! Ya podés pasar a retirarlo.${donde}`,
      en_camino: '🛵 ¡Tu pedido salió! Ya va para tu casa.',
      entregado: null,
      cancelado: '😕 Tu pedido quedó cancelado. Cualquier duda, escribí *4* y te responde una persona.',
      rechazado: '😕 El local no puede preparar tu pedido ahora. Si querés, escribí *4* y te responde una persona.',
    }[estado];
    return texto ? { para: telefono, texto } : null;
  }
  if (estado === 'aceptado') {
    const donde = config.negocio.direccion ? `\n📍 ${config.negocio.direccion}` : '';
    return { para: telefono, texto: `✅ ¡Tu pedido está confirmado! Pasá a retirarlo por el local cuando quieras.${donde}\n${AVISO_PRECIO}` };
  }
  if (estado !== 'rechazado' && estado !== 'cancelado') return null;
  return { para: telefono, texto: '😕 El local no puede preparar tu pedido ahora. Si querés, escribí *4* y te responde una persona.' };
}

module.exports = { procesar, avisoDePedido, cantidadYProducto };
