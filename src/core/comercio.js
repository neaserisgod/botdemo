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
const espejo = require('./espejo');
const faq = require('./flujos/faq');
const nlu = require('./nlu');
const numeros = require('./diccionario/numeros');
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
  if (!gastro.formas(ctx.config).some((f) => f.envio)) return POR_DEFECTO;
  const zs = gastro.zonas(ctx.config);
  const lista = zs.length ? `\n${zs.map((z) => `• ${z.nombre} — ${catalogo.plata(gastro.costoEnvio({ envio: true }, z))}`).join('\n')}` : '';
  return { envios: `¡Sí, te lo llevamos! 🛵${lista}\nPara armar tu pedido, escribí *pedido*.` };
}

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
    eligiendo_entrega, pidiendo_direccion, eligiendo_zona, eligiendo_pago,
  };
  return (manejadores[clienta.estado_conv] || inicio)(ctx);
}

function menu(ctx, saludo) {
  const encabezado = saludo ? `${saludo}\n\n` : '';
  menuVisto(ctx);
  const g = gastro.esGastro(ctx.config);
  const ver = g ? `Ver la carta ${ctx.config.textos.emoji}` : `Consultar precios ${ctx.config.textos.emoji}`;
  const pedir = g ? 'Hacer un pedido' : 'Hacer un pedido para retirar';
  return responder(ctx, 'inicio',
    `${encabezado}¿Qué necesitás?\n\n*1* — ${ver}\n*2* — ${pedir}\n*3* — Ubicación y horarios\n*4* — Hablar con una persona\n\nRespondé con el número, o escribime directo qué buscás.`);
}

const sinCatalogo = (ctx) => responder(ctx, 'inicio',
  'Todavía no tengo cargada la lista de precios 😅 Escribí *4* y te responde una persona.');

// Una línea por producto: "Coca 2,25 L — $3.500 ✅" o "… ❌ sin stock".
const lineaProducto = (x) => `• ${nombreConPrecio(x)} ${x.hay ? '✅' : '❌ sin stock'}`;

// ---------- inicio: consultas ----------
const PIDE_PEDIDO = ['pedido', 'pedir', 'hacer un pedido', 'quiero pedir', 'encargar', 'encargo', 'reservar'];
const PIDE_PRECIO = ['precio', 'precios', 'cuanto', 'sale', 'cuesta', 'vale', 'hay', 'tienen', 'tenes', 'queda', 'quedan', 'stock'];

// Después del "1" (consultar precios) cada mensaje es un producto: lo que no está dice "no encontré" (no el menú) y se
// sigue consultando sin volver a poner "1". Lo demás (las otras opciones, "pedido", "gracias", "hola") anda como en inicio.
const consultando = (ctx) => inicio(ctx, 'consultando');

function inicio(ctx, estado = 'inicio') {
  let t = ctx.texto;
  const sinEntender = ctx.datos.sinEntender || 0;
  delete ctx.datos.sinEntender;
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
  // "hola, ¿me podés cortar 200 de jamón, 1/4 de queso y 100 de salame?": el pedido entero en el primer mensaje.
  const enMensaje = pedidoEnElMensaje(ctx);
  if (enMensaje) return enMensaje;
  // "¿me pasás el catálogo?", "¿qué tienen en la carta?": la carta (o el link del catálogo de WhatsApp).
  if (gastro.esGastro(ctx.config) && /\b(?:catalogo|carta|que tienen hoy|que hay hoy)\b/.test(norm)) return carta(ctx);
  if (PIDE_PEDIDO.some((k) => nlu.contiene(norm, tokens, k))) return empezarPedido(ctx);

  // Lo que pregunta en el mismo mensaje va antes que pasarlo a una persona: "¿alguien me atiende? quiero saber si tienen
  // leche" se contesta con la leche (y la opción de hablar con alguien).
  const buscado = catalogo.palabrasClave(t).length && catalogo.cargado() ? catalogo.buscar(t, 5, sinonimos(ctx)) : null;
  if (inter.intencion === 'humano' && !(buscado && buscado.resultados.length)) return derivarAHumano(ctx, ctx.msj.texto);

  // Envíos, cómo se paga, horarios, ubicación y las preguntas que cargó el negocio.
  const tm = nlu.tema(ctx.config, t);
  if (tm) return responderTema(ctx, tm, porDefecto(ctx), estado === 'consultando' ? 'consultando' : 'inicio');

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
      return responder(ctx, estado, 'No encontré ese producto 🤔 Probá con otro nombre, o escribí *4* para preguntarle a una persona.');
    }
  }
  // Enojo sin otro pedido: perdón, y una persona.
  const enojado = enojo(ctx);
  if (enojado) return enojado;
  if (inter.intencion === 'saludo') return menu(ctx, `¡Hola! 👋 Soy el asistente de *${ctx.config.negocio.nombre}*.`);
  // Lo que no se entendió queda anotado; a la segunda seguida, una persona en vez del menú otra vez.
  anotarNoEntendido(ctx);
  if (sinEntender >= 1) {
    return derivarAHumano(ctx, ctx.msj.texto, `Perdón, no te estoy entendiendo 😅 Ya le aviso ${aQuienAtiende(ctx.config.textos)} para que te responda personalmente.`);
  }
  ctx.datos.sinEntender = sinEntender + 1;
  if (!pregunta) return menu(ctx, `¡Hola! 👋 Soy el asistente de *${ctx.config.negocio.nombre}*.`);
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
// Verbos de pedido de mostrador y de delivery: "cortame", "¿me podés cortar…?", "preparame", "dame", "quiero", "me llevo",
// "me mandás", "me traés".
const VERBO_PEDIDO = '(?:me )?(?:podes |podrias |puedes |vas a )?(?:cortar|cortame|cortas|preparar|preparame|preparas|separar|separame|separas|guardar|guardame|guardas|anotar|anotame|anotas|dar|dame|das|mandar|mandame|mandas|mandan|enviar|enviame|envias|quiero|quisiera|queria|necesito|me llevo|llevo|encargar|encargo|pedir|pido|traer|traeme|traes|traen)';
const SALUDO_INICIAL = /^(?:(?:hola|holis|buenas|buen dia|buenos dias|buenas tardes|buenas noches|che|como va|que tal|disculpa|perdon)[\s,!.¡¿?]*)+/;
const RELLENO_FINAL = /[\s,.!?¿¡]*(?:(?:porfa|por favor|gracias|plis|please|dale)[\s,.!?¿¡]*)*$/;

// Si el mensaje es un pedido ("hola, ¿me podés cortar 200 de jamón y 1/4 de queso?", "quiero 2 cocas y 1/4 de jamón"),
// arranca el pedido con todo anotado. Hace falta un verbo de pedido o que algún renglón traiga cantidad o peso, y que
// algún producto exista; "¿cuánto sale el 1/4 de jamón?" o "¿tienen coca?" siguen siendo consultas.
function pedidoEnElMensaje(ctx) {
  if (!catalogo.cargado()) return null;
  let t = (ctx.msj.texto || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(SALUDO_INICIAL, '');
  const norm = nlu.normalizar(t);
  if (/\b(?:cuanto|cuanta|precio|precios|sale|salen|cuesta|cuestan|vale|valen)\b/.test(norm)) return null;
  const conVerbo = new RegExp(`^${VERBO_PEDIDO}\\b\\s*`);
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
  const productos = leidas.filter(esProducto);
  const conCantidad = leidas.some(({ l }) => numeros.pesoInicial(l) || numeros.cantidadInicial(l));
  if (!productos.length || !(verbo || conCantidad)) return null;
  if (gastro.pausada(ctx.config)) return cocinaPausada(ctx);
  ctx.datos = { items: [] };
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

function empezarPedido(ctx) {
  if (!catalogo.cargado()) return sinCatalogo(ctx);
  if (gastro.pausada(ctx.config)) return cocinaPausada(ctx);
  ctx.datos = { items: [] };
  const ej = gastro.esGastro(ctx.config) ? '*2 milanesas*, *1 docena de empanadas*' : '*2 coca*, *1/4 de jamón*';
  return responder(ctx, 'armando_pedido',
    `${encabezadoPedido(ctx)}\nDecime qué querés y cuánto (ej: ${ej}). Podés mandar varias cosas juntas, una por renglón.\nCuando termines, escribí *listo*.`);
}

// El carrito que mandó desde el catálogo de WhatsApp (el adaptador lo lee: `[{ retailerId, nombre, cantidad }]`, o `[]` si no
// pudo). Cada producto del catálogo de WhatsApp lleva como "ID de contenido" (retailer id) el global_id del plato en Nodo Sur;
// si no lo tiene, se busca por el nombre. El precio es el de Nodo Sur, no el que dice WhatsApp: es el que cobra la caja.
function carritoDelCatalogo(ctx) {
  const lineas = Array.isArray(ctx.msj.carrito) ? ctx.msj.carrito : [];
  if (!lineas.length) {
    return responder(ctx, ctx.clienta.estado_conv || 'inicio', 'No pude leer tu carrito 😅 ¿Me escribís qué querés? (ej: *2 milanesas*)');
  }
  if (!catalogo.cargado()) return sinCatalogo(ctx);
  if (gastro.pausada(ctx.config)) return cocinaPausada(ctx);
  ctx.datos = { items: [] };
  const notas = [];
  for (const x of lineas.slice(0, MAX_LINEAS)) {
    const cantidad = Math.min(Math.max(Math.trunc(Number(x.cantidad) || 1), 1), 999);
    // El bot pone `ns-<global_id>` (`espejo.js`); uno cargado a mano puede tener el global_id solo.
    const gid = x.retailerId ? espejo.gidDeRetailer(String(x.retailerId)) || String(x.retailerId) : null;
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
// Devuelve { tipo, ... }: 'nada' | 'no_encontre' | 'cantidad_mala' | 'paquete' | 'elegir' | 'pesar' | 'anotar'.
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
  if (!resultados.length) return { tipo: 'no_encontre', busqueda };
  if (resultados.length > 1) return { tipo: 'elegir', resultados, cantidad, gramos: gramosDichos };
  const producto = resultados[0];
  if (catalogo.esPesable(producto)) return gramosDichos ? { tipo: 'anotar', producto, gramos: gramosDichos } : { tipo: 'pesar', producto };
  if (cantidad < 1 || cantidad > 999) return { tipo: 'cantidad_mala' };
  return { tipo: 'anotar', producto, cantidad };
}

const TERMINAR = ['listo', 'nada mas', 'eso es todo', 'eso', 'termine', 'ya esta', 'nada', 'no'];

function armando_pedido(ctx) {
  const norm = nlu.normalizar(ctx.texto);
  if (['cancelar', 'cancela', 'cancelo', '0'].includes(norm)) {
    ctx.datos = {};
    return responder(ctx, 'inicio', 'Listo, no anoté nada. Cuando quieras escribí *hola* 😊');
  }
  // "listo", y también "listo gracias", "eso es todo, gracias".
  if (TERMINAR.includes(norm) || (nlu.esCortesia(ctx.msj.texto || '') && /\b(?:listo|eso es todo|nada mas|ya esta|eso nomas)\b/.test(norm))) return terminarPedido(ctx);
  const texto = ctx.msj.texto || '';
  const lineas = separarLineas(texto);
  if (lineas.length > 1) return anotarVarias(ctx, lineas, []);

  const r = leerLinea(ctx, texto);
  if (r.tipo === 'no_encontre') {
    // No es un producto: ¿es una pregunta de siempre ("¿hacen envíos?", "¿hasta qué hora están?")? Se contesta sin perder
    // lo anotado. Va después de buscar en el catálogo, así una palabra de un producto nunca se confunde con una pregunta.
    const aparte = entenderEnPaso(ctx, '¿Algo más? Si no, escribí *listo*.');
    if (aparte) return aparte;
    // "jamón y queso": dos productos, si cada uno existe por separado.
    const partes = texto.split(/\s+y\s+/i);
    if (partes.length > 1 && partes.every((x) => !['no_encontre', 'nada'].includes(leerLinea(ctx, x).tipo))) return anotarVarias(ctx, partes, []);
    anotarNoEntendido(ctx);
    return responder(ctx, 'armando_pedido', `No encontré "${r.busqueda.trim()}" 🤔 Probá con otro nombre, o *listo* para terminar.`);
  }
  if (r.tipo === 'nada') return noEntendi(ctx, 'Decime qué producto querés (ej: *2 coca*), o *listo* para terminar.');
  if (r.tipo === 'cantidad_mala') return responder(ctx, 'armando_pedido', 'Esa cantidad no la puedo anotar 😅 Probá de nuevo (ej: *2 coca*).');
  if (r.tipo === 'paquete') return responder(ctx, 'armando_pedido', `${textoPaquete(r.producto)} ¿Cuántos querés? (ej: *1 ${catalogo.palabrasClave(r.producto.nombre)[0]}*)`);
  if (r.tipo === 'pesar') return preguntarPeso(ctx, r.producto, []);
  if (r.tipo === 'elegir') return preguntarCual(ctx, r.resultados, r.cantidad, [], r.gramos);
  return agregar(ctx, r.producto, r);
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
    const r = leerLinea(ctx, linea);
    if (r.tipo === 'nada') continue;
    if (r.tipo === 'cantidad_mala') notas.push(`❌ "${linea}": esa cantidad no la puedo anotar`);
    else if (r.tipo === 'no_encontre') { notas.push(`❌ No encontré "${r.busqueda.trim()}"`); anotarNoEntendido({ ...ctx, msj: { texto: linea } }); }
    else if (r.tipo === 'paquete') notas.push(`📦 ${textoPaquete(r.producto)}: decime cuántos`);
    else if (r.tipo === 'anotar') notas.push(sumar(ctx, r.producto, r).nota);
    else {
      ctx.datos.pendientes = resto;
      return r.tipo === 'pesar' ? preguntarPeso(ctx, r.producto, notas) : preguntarCual(ctx, r.resultados, r.cantidad, notas, r.gramos);
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

function preguntarCual(ctx, resultados, cantidad, notas, gramos) {
  ctx.datos.opciones = resultados.map((x) => x.gid);
  ctx.datos.cantidad = cantidad;
  if (gramos) ctx.datos.gramos = gramos; else delete ctx.datos.gramos;
  const antes = notas.length ? `${notas.join('\n')}\n\n` : '';
  const lista = resultados.map((x, i) => `*${i + 1}* — ${nombreConPrecio(x)}${x.hay ? '' : ' (sin stock)'}`).join('\n');
  return responder(ctx, 'eligiendo_producto', `${antes}¿Cuál de estos?\n\n${lista}\n\nRespondé con el número, o *0* para buscar otro.`);
}

function eligiendo_producto(ctx) {
  const limpiar = () => { delete ctx.datos.opciones; delete ctx.datos.cantidad; delete ctx.datos.gramos; };
  if (ctx.texto === '0') { limpiar(); return seguir(ctx, []); }
  const n = numerosDe(ctx.texto)[0];
  const gid = n ? (ctx.datos.opciones || [])[n - 1] : null;
  const producto = gid ? catalogo.porGid(gid) : null;
  if (!producto) return noEntendi(ctx, 'Elegí un número de la lista, o *0* para buscar otro.');
  const { cantidad = 1, gramos } = ctx.datos;
  limpiar();
  if (catalogo.esPesable(producto) && !gramos) return preguntarPeso(ctx, producto, []);
  const pedido = catalogo.esPesable(producto) ? { gramos } : { cantidad: Math.min(cantidad, 999) };
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
const cuantoDe = (x) => (x.gramos ? `${numeros.textoPeso(x.gramos)} de ${catalogo.nombreCorto(x)}` : `${x.cantidad} × ${x.nombre}`);
const subtotal = (x) => (x.gramos ? catalogo.precioDeGramos(x.precioCentavos, x.gramos) : x.precioCentavos * x.cantidad);

// Suma el producto al pedido (si hay stock y entra): { cantidad } por unidad o { gramos } si se pesa. Devuelve si se
// anotó y la línea para contarlo.
function sumar(ctx, producto, { cantidad, gramos }) {
  if (!producto.hay) return { ok: false, nota: `❌ No hay stock de *${catalogo.esPesable(producto) ? catalogo.nombreCorto(producto) : producto.nombre}* ahora 😕` };
  const items = ctx.datos.items || [];
  const nuevo = gramos
    ? { gid: producto.gid, nombre: producto.nombre, gramos, precioCentavos: producto.precioCentavos }
    : { gid: producto.gid, nombre: producto.nombre, cantidad, precioCentavos: producto.precioCentavos };
  const ya = items.find((x) => x.gid === producto.gid && !!x.gramos === !!gramos);
  if (ya && gramos) ya.gramos = Math.min(50000, ya.gramos + gramos);
  else if (ya) ya.cantidad = Math.min(999, ya.cantidad + cantidad);
  else {
    if (items.length >= MAX_LINEAS) return { ok: false, lleno: true, nota: `❌ Ya es un pedido grande 😅 No anoté *${producto.nombre}*.` };
    items.push(nuevo);
  }
  ctx.datos.items = items;
  return { ok: true, nota: `✍️ ${cuantoDe(nuevo)} — ${catalogo.plata(subtotal(nuevo))}${gramos ? ' aprox. ⚖️' : ''}` };
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
      const lista = zs.map((z, i) => `*${i + 1}* — ${z.nombre} (envío ${catalogo.plata(gastro.costoEnvio(forma, z))})`).join('\n');
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
  const r = elegir(ctx, formas.length, (t) => formas.findIndex((f) => (f.envio
    ? /\b(?:envio|enviar|envialo|traer|traigan|traen|llevar|lleven|delivery|domicilio|casa)\b/.test(t)
    : /\b(?:retiro|retirar|retira|busco|buscar|paso|local)\b/.test(t))));
  if (r.cancelar) return cancelar(ctx);
  if (r.i === undefined) return noEntendi(ctx, 'Respondé con el número de la lista, o *0* para cancelar.');
  ctx.datos.entrega = formas[r.i].clave;
  return siguienteGastro(ctx);
}

function pidiendo_direccion(ctx) {
  const dir = (ctx.msj.texto || '').trim();
  if (dir === '0') return cancelar(ctx);
  if (dir.length < 4 || dir.length > 160 || !/[a-zA-ZáéíóúñÑ]/.test(dir) || dir.includes('?')) {
    return responder(ctx, 'pidiendo_direccion', 'Necesito la dirección para llevártelo 🏠 (ej: *Mitre 150, timbre B*; o *0* para cancelar)');
  }
  ctx.datos.direccion = dir;
  return siguienteGastro(ctx);
}

function eligiendo_zona(ctx) {
  const zs = gastro.zonas(ctx.config);
  const r = elegir(ctx, zs.length, (t) => zs.findIndex((z) => nlu.normalizar(z.nombre) === t));
  if (r.cancelar) return cancelar(ctx);
  if (r.i === undefined) return noEntendi(ctx, 'Respondé con el número de tu zona, o *0* para cancelar.');
  ctx.datos.zona = zs[r.i].nombre;
  return siguienteGastro(ctx);
}

function eligiendo_pago(ctx) {
  const pagos = gastro.pagos(ctx.config);
  const r = elegir(ctx, pagos.length, (t) => pagos.findIndex((p) => ({
    alias: /\b(?:transfiero|transferencia|transferir|alias)\b/,
    mp: /\b(?:mercado ?pago|mp|link|tarjeta)\b/,
    al_entregar: /\b(?:efectivo|recibir|entregar|cuando llegue|al retirar|despues)\b/,
  })[p].test(t)));
  if (r.cancelar) return cancelar(ctx);
  if (r.i === undefined) return noEntendi(ctx, 'Respondé con el número, o *0* para cancelar.');
  ctx.datos.pago = pagos[r.i];
  return siguienteGastro(ctx);
}

// Lo de la entrega que va al pedido y al resumen: la forma, la zona elegida y lo que sale el envío.
function entregaDe(ctx) {
  const forma = gastro.FORMAS[ctx.datos.entrega] || gastro.FORMAS.RETIRO;
  const zona = forma.envio ? gastro.zonas(ctx.config).find((z) => z.nombre === ctx.datos.zona) || null : null;
  return { forma, zona, costo: gastro.costoEnvio(forma, zona) };
}

function pidiendo_nombre(ctx) {
  const nombre = (ctx.msj.texto || '').trim();
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
  const sale = gastro.cuandoSale(ctx.config, forma, entregaDe(ctx).zona);
  if (!sale) return cocinaPausada(ctx);
  const total = items.reduce((s, x) => s + subtotal(x), 0) + costo;
  const lineas = items.map((x) => `• ${cuantoDe(x)} — ${catalogo.plata(subtotal(x))}`).join('\n');
  const envio = forma.envio ? `\n🛵 Envío a ${ctx.datos.direccion} (${ctx.datos.zona}) — ${catalogo.plata(costo)}` : '';
  const donde = forma.envio ? '' : '\n📍 Lo retirás en el local.';
  const cuando = sale.programado
    ? `🕐 Ahora estamos cerrados: lo dejamos programado y está ${forma.envio ? 'llegando' : 'listo'} ${gastro.textoHora(sale.hora)}.`
    : `🕐 ${forma.envio ? 'Llega' : 'Está listo'} ${gastro.textoHora(sale.hora)} aprox.`;
  const pago = { alias: '\n💳 Pagás ahora por transferencia.', mp: '\n💳 Pagás ahora con Mercado Pago (te paso el link).' }[ctx.datos.pago] || '\n💵 Pagás al recibir.';
  return responder(ctx, 'confirmando_pedido',
    `${ctx.clienta.nombre}, tu pedido:\n\n${lineas}${envio}\n\n💰 Total: ${catalogo.plata(total)}${donde}\n${cuando}${pago}\n\n*1* — Confirmar\n*2* — Agregar algo más\n*0* — Cancelar`);
}

// El pedido de un local gastronómico: la hora se vuelve a sacar al confirmar (la cocina pudo cambiar mientras tanto).
function confirmarGastro(ctx) {
  const { forma, zona, costo } = entregaDe(ctx);
  const sale = gastro.cuandoSale(ctx.config, forma, zona);
  if (!sale) return cocinaPausada(ctx);
  const items = ctx.datos.items;
  qPedidos.crear(ctx.clienta.id, {
    cliente: { nombre: ctx.clienta.nombre, telefono: ctx.clienta.telefono },
    items,
    entrega: { forma: forma.clave, ...(forma.envio ? { direccion: ctx.datos.direccion, zona: ctx.datos.zona, costoEnvioCentavos: costo } : {}) },
    pago: ctx.datos.pago || 'al_entregar',
    horaEstimada: sale.hora.getTime(),
    ...(sale.programado ? { programado: true } : {}),
  });
  const total = items.reduce((s, x) => s + subtotal(x), 0) + costo;
  const pago = ctx.datos.pago;
  ctx.datos = {};
  // Por Mercado Pago el link llega apenas el sitio lo arma (`nube/sincronizar.js`), y el local lo ve cuando se acredita.
  if (pago === 'mp') return responder(ctx, 'inicio', `¡Listo! Ya te paso el link para pagar ${catalogo.plata(total)} 💳 Apenas se acredita, le llega tu pedido al local.`);
  const pagar = pago === 'alias' ? `\n\n${gastro.textoAlias(ctx.config, catalogo.plata(total))}` : '';
  return responder(ctx, 'inicio', `¡Listo! Le pasé tu pedido al local 🙌 Te aviso por acá apenas lo confirmen.${pagar}`);
}

function confirmando_pedido(ctx) {
  if (nlu.esSi(ctx.texto) || /^(?:confirmo|confirmar|confirmado|mandalo|pedilo)$/.test(nlu.normalizar(ctx.texto))) ctx.texto = '1';
  if (ctx.texto === '2') return responder(ctx, 'armando_pedido', 'Dale, decime qué más querés.');
  if (ctx.texto === '0') { ctx.datos = {}; return responder(ctx, 'inicio', 'Listo, no anoté nada. Cuando quieras escribí *hola* 😊'); }
  if (ctx.texto !== '1') return noEntendi(ctx, 'Respondé *1* para confirmar, *2* para agregar algo o *0* para cancelar.');
  if (gastro.esGastro(ctx.config)) return confirmarGastro(ctx);
  qPedidos.crear(ctx.clienta.id, {
    cliente: { nombre: ctx.clienta.nombre, telefono: ctx.clienta.telefono },
    items: ctx.datos.items,
  });
  ctx.datos = {};
  return responder(ctx, 'inicio', '¡Listo! Le pasé tu pedido al local 🙌 Te aviso por acá apenas lo confirmen.');
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
  const tm = nlu.tema(ctx.config, t);
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
    const hora = pedido.datos.horaEstimada ? ` (${gastro.textoHora(new Date(pedido.datos.horaEstimada))} aprox.)` : '';
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
