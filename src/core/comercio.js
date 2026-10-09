// Conversación de un comercio (forma productos: almacén, kiosco, fiambrería). Decisiones del dueño (2026-10-09,
// Nodo-Sur-Pos/docs/PLAN-BOT.md):
//  * contesta precio y si hay, sacado del catálogo que publica Nodo Sur (`catalogo.js`);
//  * contesta ubicación y horarios;
//  * toma pedidos para RETIRAR EN EL LOCAL (sin envío). Un producto sin stock no se agrega (sin stock no se vende);
//  * el precio es el de hoy y puede cambiar: el que vale es el del día que retira (como cualquier encargue);
//  * el pedido entra en Nodo Sur "por confirmar" (no aparta stock): el bot lo guarda en la bandeja (`pedidos`), `nube/`
//    lo manda y, cuando el local lo acepta o rechaza en la app, `avisoDePedido` arma el mensaje para el cliente.
//
// Estados (en clientas.estado_conv, como los turnos): inicio → armando_pedido ⇄ eligiendo_producto → pidiendo_nombre →
// confirmando_pedido → inicio.
const qClientas = require('../db/consultas/clientas');
const qPedidos = require('../db/consultas/pedidos');
const catalogo = require('./catalogo');
const faq = require('./flujos/faq');
const nlu = require('./nlu');
const { responder, noEntendi, derivarAHumano, numerosDe, VOLVER_AL_MENU, CORTESIA } = require('./maquina');

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

  if (VOLVER_AL_MENU.includes(ctx.texto.replace(/[!.,¿?]/g, '').trim())) {
    ctx.datos = {};
    return menu(ctx, '¡Volvamos al principio!');
  }
  const manejadores = { inicio, armando_pedido, eligiendo_producto, pidiendo_nombre, confirmando_pedido };
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

function inicio(ctx) {
  const t = ctx.texto;
  if (!t) return [];
  const tLimpio = t.replace(/[!.,~\s]+$/g, '');
  if (CORTESIA.includes(tLimpio)) return responder(ctx, 'inicio', '¡Gracias a vos! 😊 Cualquier cosa escribime *hola*.');

  if (t === '1') return responder(ctx, 'inicio', `Decime qué producto buscás y te paso el precio y si hay ${ctx.config.textos.emoji}\n(por ejemplo: *coca*, *pan lactal*)`);
  if (t === '2') return empezarPedido(ctx);
  if (t === '3') return responder(ctx, 'inicio', faq.ubicacionYHorarios(ctx.config));
  if (t === '4') return derivarAHumano(ctx, '(pidió hablar con una persona)');

  const norm = nlu.normalizar(t);
  const tokens = norm.split(' ');
  const inter = nlu.interpretar(t);
  if (inter.intencion === 'humano') return derivarAHumano(ctx, ctx.msj.texto);
  if (PIDE_PEDIDO.some((k) => nlu.contiene(norm, tokens, k))) return empezarPedido(ctx);

  // Ubicación y horarios por palabras clave (las de precios no: "¿cuánto sale la coca?" es una consulta al catálogo).
  const faqLugar = [...ctx.config.faq.ubicacion, ...ctx.config.faq.horarios];
  if (faqLugar.some((k) => nlu.contiene(norm, tokens, nlu.normalizar(k)))) return responder(ctx, 'inicio', faq.ubicacionYHorarios(ctx.config));

  const pregunta = PIDE_PRECIO.some((k) => tokens.includes(k)) || t.includes('?');
  if (catalogo.palabrasClave(t).length) {
    if (!catalogo.cargado()) return sinCatalogo(ctx);
    const { resultados, total } = catalogo.buscar(t);
    if (resultados.length) {
      const mas = total > resultados.length ? `\n…y ${total - resultados.length} más: decime algo más específico.` : '';
      return responder(ctx, 'inicio', `${resultados.map(lineaProducto).join('\n')}${mas}\n\n${AVISO_PRECIO}\nPara pedir, escribí *pedido*.`);
    }
    // Preguntó por algo que no está: no es que no lo entendimos.
    if (pregunta) return responder(ctx, 'inicio', 'No encontré ese producto 🤔 Probá con otro nombre, o escribí *4* para preguntarle a una persona.');
  }
  if (inter.intencion === 'saludo' || !pregunta) return menu(ctx, `¡Hola! 👋 Soy el asistente de *${ctx.config.negocio.nombre}*.`);
  return noEntendi(ctx, 'No te entendí bien 🤔 Decime qué producto buscás, o escribí *menú* para ver las opciones.');
}

// ---------- pedido ----------
function empezarPedido(ctx) {
  if (!catalogo.cargado()) return sinCatalogo(ctx);
  ctx.datos = { items: [] };
  return responder(ctx, 'armando_pedido',
    `¡Dale! ${ctx.config.textos.emoji} Lo preparamos para que lo *retires en el local*.\nDecime qué querés, de a uno y con la cantidad (ej: *2 coca*).\nCuando termines, escribí *listo*.`);
}

// "2 coca", "coca x2", "coca": cantidad (1 si no dice) y lo que busca.
function cantidadYProducto(texto) {
  const t = texto.trim();
  let m = t.match(/^(\d{1,3})\s*(?:x\s*)?(.+)$/i);
  if (m) return { cantidad: Number(m[1]), busqueda: m[2] };
  m = t.match(/^(.+?)\s*x\s*(\d{1,3})$/i);
  if (m) return { cantidad: Number(m[2]), busqueda: m[1] };
  return { cantidad: 1, busqueda: t };
}

const TERMINAR = ['listo', 'nada mas', 'eso es todo', 'eso', 'termine', 'ya esta', 'nada', 'no'];

function armando_pedido(ctx) {
  const norm = nlu.normalizar(ctx.texto);
  if (['cancelar', 'cancela', 'cancelo', '0'].includes(norm)) {
    ctx.datos = {};
    return responder(ctx, 'inicio', 'Listo, no anoté nada. Cuando quieras escribí *hola* 😊');
  }
  if (TERMINAR.includes(norm)) return terminarPedido(ctx);

  const { cantidad, busqueda } = cantidadYProducto(ctx.msj.texto || '');
  if (!catalogo.palabrasClave(busqueda).length) return noEntendi(ctx, 'Decime qué producto querés (ej: *2 coca*), o *listo* para terminar.');
  if (cantidad < 1 || cantidad > 999) return responder(ctx, 'armando_pedido', 'Esa cantidad no la puedo anotar 😅 Probá de nuevo (ej: *2 coca*).');
  const { resultados } = catalogo.buscar(busqueda);
  if (!resultados.length) return responder(ctx, 'armando_pedido', `No encontré "${busqueda.trim()}" 🤔 Probá con otro nombre, o *listo* para terminar.`);
  if (resultados.length === 1) return agregar(ctx, resultados[0], cantidad);

  ctx.datos.opciones = resultados.map((x) => x.gid);
  ctx.datos.cantidad = cantidad;
  const lista = resultados.map((x, i) => `*${i + 1}* — ${x.nombre} — ${catalogo.plata(x.precioCentavos)}${x.hay ? '' : ' (sin stock)'}`).join('\n');
  return responder(ctx, 'eligiendo_producto', `¿Cuál de estos?\n\n${lista}\n\nRespondé con el número, o *0* para buscar otro.`);
}

function eligiendo_producto(ctx) {
  if (ctx.texto === '0') { delete ctx.datos.opciones; return responder(ctx, 'armando_pedido', 'Dale, decime qué buscás.'); }
  const n = numerosDe(ctx.texto)[0];
  const gid = n ? (ctx.datos.opciones || [])[n - 1] : null;
  const producto = gid ? catalogo.porGid(gid) : null;
  if (!producto) return noEntendi(ctx, 'Elegí un número de la lista, o *0* para buscar otro.');
  const cantidad = ctx.datos.cantidad || 1;
  delete ctx.datos.opciones; delete ctx.datos.cantidad;
  return agregar(ctx, producto, cantidad);
}

function agregar(ctx, producto, cantidad) {
  if (!producto.hay) {
    return responder(ctx, 'armando_pedido', `No hay stock de *${producto.nombre}* ahora 😕 ¿Querés algo más? Si no, escribí *listo*.`);
  }
  const items = ctx.datos.items || [];
  const ya = items.find((x) => x.gid === producto.gid);
  if (ya) ya.cantidad = Math.min(999, ya.cantidad + cantidad);
  else {
    if (items.length >= MAX_LINEAS) return responder(ctx, 'armando_pedido', 'Ya es un pedido grande 😅 Escribí *listo* para mandarlo.');
    items.push({ gid: producto.gid, nombre: producto.nombre, cantidad, precioCentavos: producto.precioCentavos });
  }
  ctx.datos.items = items;
  return responder(ctx, 'armando_pedido',
    `Anotado: ${cantidad} × ${producto.nombre} — ${catalogo.plata(producto.precioCentavos * cantidad)} ✍️\n¿Algo más? Si no, escribí *listo*.`);
}

function terminarPedido(ctx) {
  if (!(ctx.datos.items || []).length) {
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
  const items = ctx.datos.items;
  const total = items.reduce((s, x) => s + x.precioCentavos * x.cantidad, 0);
  const lineas = items.map((x) => `• ${x.cantidad} × ${x.nombre} — ${catalogo.plata(x.precioCentavos * x.cantidad)}`).join('\n');
  return responder(ctx, 'confirmando_pedido',
    `${ctx.clienta.nombre}, tu pedido:\n\n${lineas}\n\n💰 Total aproximado: ${catalogo.plata(total)}\n📍 Lo retirás en el local.\n${AVISO_PRECIO}\n\n*1* — Confirmar\n*2* — Agregar algo más\n*0* — Cancelar`);
}

function confirmando_pedido(ctx) {
  if (ctx.texto === '2') return responder(ctx, 'armando_pedido', 'Dale, decime qué más querés.');
  if (ctx.texto === '0') { ctx.datos = {}; return responder(ctx, 'inicio', 'Listo, no anoté nada. Cuando quieras escribí *hola* 😊'); }
  if (ctx.texto !== '1') return noEntendi(ctx, 'Respondé *1* para confirmar, *2* para agregar algo o *0* para cancelar.');
  qPedidos.crear(ctx.clienta.id, {
    cliente: { nombre: ctx.clienta.nombre, telefono: ctx.clienta.telefono },
    items: ctx.datos.items,
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
