// Conversación de un comercio (forma productos: almacén, kiosco, fiambrería). Decisiones del dueño (2026-10-09,
// Nodo-Sur-Pos/docs/PLAN-BOT.md):
//  * contesta precio y si hay, sacado del catálogo que publica Nodo Sur (`catalogo.js`);
//  * contesta ubicación y horarios;
//  * toma pedidos para RETIRAR EN EL LOCAL (sin envío). Un producto sin stock no se agrega (sin stock no se vende);
//  * el precio es el de hoy y puede cambiar: el que vale es el del día que retira (como cualquier encargue);
//  * el pedido entra en Nodo Sur "por confirmar" (no aparta stock): el bot lo guarda en la bandeja (`pedidos`), `nube/`
//    lo manda y, cuando el local lo acepta o rechaza en la app, `avisoDePedido` arma el mensaje para el cliente.
//
// Estados (en clientas.estado_conv, como los turnos): inicio ⇄ consultando (después del "1": cada mensaje es un producto);
// inicio → armando_pedido ⇄ eligiendo_producto → pidiendo_nombre → confirmando_pedido → inicio.
const qClientas = require('../db/consultas/clientas');
const qPedidos = require('../db/consultas/pedidos');
const catalogo = require('./catalogo');
const faq = require('./flujos/faq');
const nlu = require('./nlu');
const numeros = require('./diccionario/numeros');
const rubros = require('./diccionario/rubros');
const { responder, noEntendi, anotarNoEntendido, derivarAHumano, responderTema, numerosDe } = require('./maquina');

// Los sinónimos de productos del rubro (diccionario/rubros.js): "birra" → cerveza, "puchos" → cigarrillos.
const sinonimos = (ctx) => rubros.productosDe(ctx.config.negocio.rubro);
// Un comercio no hace envíos (decisión del dueño, 2026-10-09): si el negocio no cargó otra cosa, eso se contesta.
const POR_DEFECTO = { envios: 'Por ahora los pedidos son para *retirar en el local* 🙌 Para armar uno, escribí *pedido*.' };

const AVISO_PRECIO = '_Precios de hoy, pueden cambiar._';
const MAX_LINEAS = 50; // lo que acepta Nodo Sur por pedido

function procesar(config, clienta, msj) {
  const texto = (msj.texto || '').trim();
  let datos = {};
  try { datos = JSON.parse(clienta.datos_conv || '{}') || {}; } catch {
    console.error(`datos_conv inválido en ${clienta.id}, reiniciando su estado`);
    clienta.estado_conv = 'inicio';
  }
  const ctx = { config, clienta, datos, msj, texto: texto.toLowerCase() };

  if (nlu.esVolverAlMenu(texto)) {
    ctx.datos = {};
    return menu(ctx, '¡Volvamos al principio!');
  }
  const manejadores = { inicio, consultando, armando_pedido, eligiendo_producto, pidiendo_nombre, confirmando_pedido };
  return (manejadores[clienta.estado_conv] || inicio)(ctx);
}

function menu(ctx, saludo) {
  const encabezado = saludo ? `${saludo}\n\n` : '';
  return responder(ctx, 'inicio',
    `${encabezado}¿Qué necesitás?\n\n*1* — Consultar precios ${ctx.config.textos.emoji}\n*2* — Hacer un pedido para retirar\n*3* — Ubicación y horarios\n*4* — Hablar con una persona\n\nRespondé con el número, o escribime directo qué buscás.`);
}

const sinCatalogo = (ctx) => responder(ctx, 'inicio',
  'Todavía no tengo cargada la lista de precios 😅 Escribí *4* y te responde una persona.');

// Una línea por producto: "Coca 2,25 L — $3.500 ✅" o "… ❌ sin stock".
const lineaProducto = (x) => `• ${x.nombre} — ${catalogo.plata(x.precioCentavos)} ${x.hay ? '✅' : '❌ sin stock'}`;

// ---------- inicio: consultas ----------
const PIDE_PEDIDO = ['pedido', 'pedir', 'hacer un pedido', 'quiero pedir', 'encargar', 'encargo', 'reservar'];
const PIDE_PRECIO = ['precio', 'precios', 'cuanto', 'sale', 'cuesta', 'vale', 'hay', 'tienen', 'tenes', 'queda', 'quedan', 'stock'];

// Después del "1" (consultar precios) cada mensaje es un producto: lo que no está dice "no encontré" (no el menú) y se
// sigue consultando sin volver a poner "1". Lo demás (las otras opciones, "pedido", "gracias", "hola") anda como en inicio.
const consultando = (ctx) => inicio(ctx, 'consultando');

function inicio(ctx, estado = 'inicio') {
  const t = ctx.texto;
  if (!t || nlu.esRisa(t)) return [];
  if (nlu.esCortesia(t)) return responder(ctx, 'inicio', '¡Gracias a vos! 😊 Cualquier cosa escribime *hola*.');

  if (t === '1') return responder(ctx, 'consultando', `Decime qué producto buscás y te paso el precio y si hay ${ctx.config.textos.emoji}\n(por ejemplo: *coca*, *pan lactal*)`);
  if (t === '2') return empezarPedido(ctx);
  if (t === '3') return responder(ctx, 'inicio', faq.ubicacionYHorarios(ctx.config));
  if (t === '4') return derivarAHumano(ctx, '(pidió hablar con una persona)');

  const norm = nlu.normalizar(t);
  const tokens = norm.split(' ');
  const inter = nlu.interpretar(t);
  if (PIDE_PEDIDO.some((k) => nlu.contiene(norm, tokens, k))) return empezarPedido(ctx);

  // Lo que pregunta en el mismo mensaje va antes que pasarlo a una persona: "¿alguien me atiende? quiero saber si tienen
  // leche" se contesta con la leche (y la opción de hablar con alguien).
  const buscado = catalogo.palabrasClave(t).length && catalogo.cargado() ? catalogo.buscar(t, 5, sinonimos(ctx)) : null;
  if (inter.intencion === 'humano' && !(buscado && buscado.resultados.length)) return derivarAHumano(ctx, ctx.msj.texto);

  // Envíos, cómo se paga, horarios, ubicación y las preguntas que cargó el negocio.
  const tm = nlu.tema(ctx.config, t);
  if (tm) return responderTema(ctx, tm, POR_DEFECTO, estado === 'consultando' ? 'consultando' : 'inicio');

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
  if (inter.intencion === 'saludo' || !pregunta) {
    if (inter.intencion !== 'saludo') anotarNoEntendido(ctx);
    return menu(ctx, `¡Hola! 👋 Soy el asistente de *${ctx.config.negocio.nombre}*.`);
  }
  return noEntendi(ctx, 'No te entendí bien 🤔 Decime qué producto buscás, o escribí *menú* para ver las opciones.');
}

// ---------- pedido ----------
function empezarPedido(ctx) {
  if (!catalogo.cargado()) return sinCatalogo(ctx);
  ctx.datos = { items: [] };
  return responder(ctx, 'armando_pedido',
    `¡Dale! ${ctx.config.textos.emoji} Lo preparamos para que lo *retires en el local*.\nDecime qué querés, de a uno y con la cantidad (ej: *2 coca*).\nCuando termines, escribí *listo*.`);
}

// "2 coca", "coca x2", "dos cocas", "un par de alfajores", "media docena de huevos", "coca": cantidad (1 si no dice) y lo
// que busca. Un número que es una medida ("1kg yerba", "2.25 l coca") no es la cantidad. `como` (diccionario/numeros.js)
// dice cómo vino la cantidad.
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

// Un renglón del pedido → qué producto y cuánto: { busqueda, cantidad, gramos?, resultados }.
//  * "1/4 de jamón", "200 g de queso": se pesa en el local (`gramos`), salvo que el producto venga de esa medida
//    ("2 kg de yerba" con "Yerba 1 kg" son 2);
//  * "9 de oro", "7up": el número es parte del nombre, no la cantidad;
//  * "media docena de huevos": primero el paquete de 6.
function leerLinea(ctx, linea) {
  const sin = sinonimos(ctx);
  const peso = numeros.pesoInicial(linea);
  if (peso) {
    const { resultados } = catalogo.buscar(peso.resto, 5, sin);
    const g = resultados.length === 1 ? catalogo.gramosPorUnidad(resultados[0]) : null;
    if (g && peso.gramos % g === 0) return { busqueda: peso.resto, cantidad: peso.gramos / g, resultados };
    return { busqueda: peso.resto, cantidad: 1, gramos: peso.gramos, resultados };
  }
  const { cantidad, busqueda, como } = leerCantidad(linea);
  if (como === 'numero') {
    const num = linea.trim().match(/^\d+/);
    const entero = num && catalogo.buscar(linea, 5, sin).resultados;
    if (entero && entero.length && entero.every((x) => catalogo.palabrasClave(x.nombre).includes(num[0]))) {
      return { busqueda: linea.trim(), cantidad: 1, resultados: entero };
    }
  }
  if (como === 'docena') {
    const paquete = catalogo.buscar(`${busqueda} ${cantidad}`, 5, sin).resultados;
    if (paquete.length) return { busqueda, cantidad: 1, resultados: paquete };
  }
  return { busqueda, cantidad, resultados: catalogo.buscar(busqueda, 5, sin).resultados };
}

const TERMINAR = ['listo', 'nada mas', 'eso es todo', 'eso', 'termine', 'ya esta', 'nada', 'no'];

function armando_pedido(ctx) {
  const norm = nlu.normalizar(ctx.texto);
  if (['cancelar', 'cancela', 'cancelo', '0'].includes(norm)) {
    ctx.datos = {};
    return responder(ctx, 'inicio', 'Listo, no anoté nada. Cuando quieras escribí *hola* 😊');
  }
  if (TERMINAR.includes(norm)) return terminarPedido(ctx);

  const lineas = separarLineas(ctx.msj.texto || '');
  if (lineas.length > 1) return anotarVarias(ctx, lineas, []);

  const { cantidad, busqueda, gramos, resultados } = leerLinea(ctx, ctx.msj.texto || '');
  if (!catalogo.palabrasClave(busqueda).length) return noEntendi(ctx, 'Decime qué producto querés (ej: *2 coca*), o *listo* para terminar.');
  if (cantidad < 1 || cantidad > 999) return responder(ctx, 'armando_pedido', 'Esa cantidad no la puedo anotar 😅 Probá de nuevo (ej: *2 coca*).');
  if (!resultados.length) {
    // "jamón y queso": dos productos, si cada uno existe por separado.
    const partes = (ctx.msj.texto || '').split(/\s+y\s+/i);
    if (partes.length > 1 && partes.every((x) => leerLinea(ctx, x).resultados.length)) return anotarVarias(ctx, partes, []);
    anotarNoEntendido(ctx);
    return responder(ctx, 'armando_pedido', `No encontré "${busqueda.trim()}" 🤔 Probá con otro nombre, o *listo* para terminar.`);
  }
  if (resultados.length === 1) return agregar(ctx, resultados[0], cantidad, gramos);
  return preguntarCual(ctx, resultados, cantidad, [], gramos);
}

// Varios productos en un mensaje: uno por renglón, o separados por coma ("2 yerba, 1 coca"). La coma entre dos números
// es de una medida ("2,25 L") y no separa.
// También "un fernet y 2 cocas": la "y" separa solo si sigue una cantidad o un peso ("jamón y queso" es un producto).
const ANTES_DE_CANTIDAD = new RegExp(`\\s+y\\s+(?=(?:\\d|1/|un cuarto|medio|media|un par|${Object.keys(numeros.PALABRAS).join('|')})\\b)`, 'i');
function separarLineas(texto) {
  return texto.split(/\n|,(?!\d)|(?<!\d),/).flatMap((x) => x.split(ANTES_DE_CANTIDAD)).map((x) => x.trim()).filter(Boolean);
}

// Anota cada renglón y junta en un solo mensaje lo anotado y lo que no se encontró. Si uno tiene varias opciones,
// pregunta cuál y guarda el resto (`pendientes`) para seguir apenas elija.
function anotarVarias(ctx, lineas, notas) {
  const resto = [...lineas];
  while (resto.length) {
    const linea = resto.shift();
    const { cantidad, busqueda, gramos, resultados } = leerLinea(ctx, linea);
    if (!catalogo.palabrasClave(busqueda).length) continue;
    if (cantidad < 1 || cantidad > 999) { notas.push(`❌ "${linea}": esa cantidad no la puedo anotar`); continue; }
    if (!resultados.length) { notas.push(`❌ No encontré "${busqueda.trim()}"`); anotarNoEntendido({ ...ctx, msj: { texto: linea } }); }
    else if (resultados.length === 1) notas.push(sumar(ctx, resultados[0], cantidad, gramos).nota);
    else {
      ctx.datos.pendientes = resto;
      return preguntarCual(ctx, resultados, cantidad, notas, gramos);
    }
  }
  delete ctx.datos.pendientes;
  if (!notas.length) return noEntendi(ctx, 'Decime qué producto querés (ej: *2 coca*), o *listo* para terminar.');
  return responder(ctx, 'armando_pedido', `${notas.join('\n')}\n\n¿Algo más? Si no, escribí *listo*.`);
}

function preguntarCual(ctx, resultados, cantidad, notas, gramos) {
  ctx.datos.opciones = resultados.map((x) => x.gid);
  ctx.datos.cantidad = cantidad;
  if (gramos) ctx.datos.gramos = gramos; else delete ctx.datos.gramos;
  const antes = notas.length ? `${notas.join('\n')}\n\n` : '';
  const lista = resultados.map((x, i) => `*${i + 1}* — ${x.nombre} — ${catalogo.plata(x.precioCentavos)}${x.hay ? '' : ' (sin stock)'}`).join('\n');
  return responder(ctx, 'eligiendo_producto', `${antes}¿Cuál de estos?\n\n${lista}\n\nRespondé con el número, o *0* para buscar otro.`);
}

function eligiendo_producto(ctx) {
  const pendientes = ctx.datos.pendientes;
  if (ctx.texto === '0') {
    delete ctx.datos.opciones; delete ctx.datos.cantidad; delete ctx.datos.gramos;
    // Venía de un mensaje con varios: sigue con lo que faltaba.
    if (pendientes && pendientes.length) return anotarVarias(ctx, pendientes, []);
    delete ctx.datos.pendientes;
    return responder(ctx, 'armando_pedido', 'Dale, decime qué buscás.');
  }
  const n = numerosDe(ctx.texto)[0];
  const gid = n ? (ctx.datos.opciones || [])[n - 1] : null;
  const producto = gid ? catalogo.porGid(gid) : null;
  if (!producto) return noEntendi(ctx, 'Elegí un número de la lista, o *0* para buscar otro.');
  const cantidad = ctx.datos.cantidad || 1;
  const gramos = ctx.datos.gramos;
  delete ctx.datos.opciones; delete ctx.datos.cantidad; delete ctx.datos.gramos;
  if (pendientes) return anotarVarias(ctx, pendientes, [sumar(ctx, producto, cantidad, gramos).nota]);
  return agregar(ctx, producto, cantidad, gramos);
}

// Lo que se pesa en el local ("250 g de Jamón cocido Paladini x kg"): va en la nota del pedido, no en las líneas, porque
// el precio sale de la balanza. Lo confirma el local.
const lineaPesada = (x) => `${numeros.textoPeso(x.gramos)} de ${x.nombre}`;

// Suma el producto al pedido (si hay stock y entra). Devuelve si se anotó y la línea para contarlo. Con `gramos`, a la
// lista de lo que se pesa.
function sumar(ctx, producto, cantidad, gramos) {
  if (!producto.hay) return { ok: false, nota: `❌ No hay stock de *${producto.nombre}* ahora 😕` };
  if (gramos) {
    const pesados = ctx.datos.pesados || [];
    const ya = pesados.find((x) => x.gid === producto.gid);
    if (ya) ya.gramos = Math.min(50000, ya.gramos + gramos);
    else pesados.push({ gid: producto.gid, nombre: producto.nombre, gramos });
    ctx.datos.pesados = pesados;
    return { ok: true, nota: `⚖️ ${lineaPesada({ nombre: producto.nombre, gramos })} (a pesar: el precio te lo confirma el local)` };
  }
  const items = ctx.datos.items || [];
  const ya = items.find((x) => x.gid === producto.gid);
  if (ya) ya.cantidad = Math.min(999, ya.cantidad + cantidad);
  else {
    if (items.length >= MAX_LINEAS) return { ok: false, nota: `❌ Ya es un pedido grande 😅 No anoté *${producto.nombre}*.` };
    items.push({ gid: producto.gid, nombre: producto.nombre, cantidad, precioCentavos: producto.precioCentavos });
  }
  ctx.datos.items = items;
  return { ok: true, nota: `✍️ ${cantidad} × ${producto.nombre} — ${catalogo.plata(producto.precioCentavos * cantidad)}` };
}

function agregar(ctx, producto, cantidad, gramos) {
  const r = sumar(ctx, producto, cantidad, gramos);
  if (r.ok && gramos) return responder(ctx, 'armando_pedido', `Anotado: ${r.nota.replace(/^⚖️ /, '')} ⚖️\n¿Algo más? Si no, escribí *listo*.`);
  if (!r.ok) {
    return responder(ctx, 'armando_pedido', producto.hay
      ? 'Ya es un pedido grande 😅 Escribí *listo* para mandarlo.'
      : `No hay stock de *${producto.nombre}* ahora 😕 ¿Querés algo más? Si no, escribí *listo*.`);
  }
  return responder(ctx, 'armando_pedido',
    `Anotado: ${cantidad} × ${producto.nombre} — ${catalogo.plata(producto.precioCentavos * cantidad)} ✍️\n¿Algo más? Si no, escribí *listo*.`);
}

function terminarPedido(ctx) {
  if (!(ctx.datos.items || []).length && !(ctx.datos.pesados || []).length) {
    return responder(ctx, 'armando_pedido', 'Todavía no anotaste nada 😅 Decime qué querés (ej: *2 coca*), o *0* para cancelar.');
  }
  if (!ctx.clienta.nombre) return responder(ctx, 'pidiendo_nombre', '¿A nombre de quién lo preparamos?');
  return resumen(ctx);
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
  return resumen(ctx);
}

function resumen(ctx) {
  const items = ctx.datos.items || [];
  const pesados = ctx.datos.pesados || [];
  const total = items.reduce((s, x) => s + x.precioCentavos * x.cantidad, 0);
  const lineas = items.map((x) => `• ${x.cantidad} × ${x.nombre} — ${catalogo.plata(x.precioCentavos * x.cantidad)}`).join('\n');
  const aPesar = pesados.length ? `${lineas ? '\n\n' : ''}⚖️ *A pesar* (el precio te lo confirma el local):\n${pesados.map((x) => `• ${lineaPesada(x)}`).join('\n')}` : '';
  const totalTxt = items.length ? `💰 Total aproximado: ${catalogo.plata(total)}${pesados.length ? ' + lo que se pesa' : ''}` : '💰 El total te lo confirma el local al pesar.';
  return responder(ctx, 'confirmando_pedido',
    `${ctx.clienta.nombre}, tu pedido:\n\n${lineas}${aPesar}\n\n${totalTxt}\n📍 Lo retirás en el local.\n${AVISO_PRECIO}\n\n*1* — Confirmar\n*2* — Agregar algo más\n*0* — Cancelar`);
}

function confirmando_pedido(ctx) {
  if (ctx.texto === '2') return responder(ctx, 'armando_pedido', 'Dale, decime qué más querés.');
  if (ctx.texto === '0') { ctx.datos = {}; return responder(ctx, 'inicio', 'Listo, no anoté nada. Cuando quieras escribí *hola* 😊'); }
  if (ctx.texto !== '1') return noEntendi(ctx, 'Respondé *1* para confirmar, *2* para agregar algo o *0* para cancelar.');
  const pesados = ctx.datos.pesados || [];
  qPedidos.crear(ctx.clienta.id, {
    cliente: { nombre: ctx.clienta.nombre, telefono: ctx.clienta.telefono },
    items: ctx.datos.items || [],
    ...(pesados.length ? { nota: `A pesar: ${pesados.map(lineaPesada).join('; ')}` } : {}),
  });
  ctx.datos = {};
  return responder(ctx, 'inicio', '¡Listo! Le pasé tu pedido al local 🙌 Te aviso por acá apenas lo confirmen.');
}

// El mensaje para el cliente cuando el local resolvió su pedido en la app.
function avisoDePedido(config, pedido, estado) {
  const telefono = pedido.datos.cliente.telefono;
  if (estado === 'aceptado') {
    const donde = config.negocio.direccion ? `\n📍 ${config.negocio.direccion}` : '';
    return { para: telefono, texto: `✅ ¡Tu pedido está confirmado! Pasá a retirarlo por el local cuando quieras.${donde}\n${AVISO_PRECIO}` };
  }
  return { para: telefono, texto: '😕 El local no puede preparar tu pedido ahora. Si querés, escribí *4* y te responde una persona.' };
}

module.exports = { procesar, avisoDePedido, cantidadYProducto };
