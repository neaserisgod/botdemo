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
const fechas = require('./fechas');
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
  // Cómo se paga lo sabe el bot (Nodo Gastro lo manda): no hace falta preguntarle al local.
  const pagos = { pagos: `${textoPagos(ctx.config)}\nCuando quieras armar el pedido, escribime *pedido*.` };
  if (!gastro.formas(ctx.config).some((f) => f.envio)) return { ...POR_DEFECTO, ...pagos };
  const zs = gastro.zonas(ctx.config);
  const costo = (z) => precioEnvio(gastro.costoEnvio({ envio: true }, z));
  // Con un solo precio de envío no hay zonas que listar.
  const lista = zs.length === 1 ? ` El envío sale ${costo(zs[0])}.`
    : zs.length ? `\n${zs.map((z) => `• ${z.nombre} — ${costo(z)}`).join('\n')}` : '';
  return { ...pagos, envios: `¡Sí, te lo llevamos! 🛵${lista}\nCuando quieras armar el pedido, escribime *pedido*.` };
}

// "Podés pagar al recibir, con Mercado Pago (tarjeta, débito o dinero en cuenta) o por transferencia."
function textoPagos(config) {
  const formas = {
    al_entregar: 'al recibir (efectivo)', mp: 'con Mercado Pago (tarjeta, débito o dinero en cuenta)', alias: 'por transferencia',
  };
  const lista = gastro.pagos(config).map((p) => formas[p]);
  const juntas = lista.length > 1 ? `${lista.slice(0, -1).join(', ')} o ${lista[lista.length - 1]}` : lista[0];
  return `💳 Podés pagar ${juntas}.`;
}

// Si está abierto ahora y, si no, cuándo abre; y cuánto tarda en llegar o en estar listo. Null sin horario cargado.
function textoAbierto(config) {
  const forma = gastro.formas(config)[0];
  const zona = forma.envio ? gastro.zonas(config)[0] : null;
  const sale = gastro.cuandoSale(config, forma, zona);
  if (!sale) return '😕 En este momento la cocina no está tomando pedidos.';
  const minutos = Math.max(1, Math.round((sale.hora - fechas.ahora()) / 60000));
  const verbo = forma.envio ? 'llega' : 'está listo';
  if (!sale.programado) return `✅ Estamos abiertos. Si pedís ahora, ${verbo} en unos ${minutos} minutos (${gastro.textoHora(sale.hora)}).`;
  return `🕐 Ahora estamos cerrados, pero podés dejar tu pedido y ${verbo} ${gastro.textoHora(sale.hora)}.`;
}

// El "3" y "¿están abiertos?" de un local gastronómico: si está abierto, los horarios, el envío y cómo se paga.
function horariosGastro(ctx) {
  const envio = porDefecto(ctx).envios;
  const extra = envio && envio !== POR_DEFECTO.envios ? `\n\n${envio.split('\n')[0]}` : '';
  return faq.conPin(responder(ctx, 'inicio', `${textoAbierto(ctx.config)}\n\n${faq.ubicacionYHorarios(ctx.config)}${extra}\n${textoPagos(ctx.config)}`), ctx.config);
}

const PIDE_RETIRO = /\b(?:retirar|retiro|retirarlo|paso a buscar|pasar a buscar|paso a retirar|buscarlo|take away|para llevar)\b/;

// "¿qué hamburguesas tienen?", "burgers?", "¿qué hamburguesas hay?": la pregunta es solo por las hamburguesas.
const BURGER = /^(?:hamburguesas?|hamburgesas?|burgers?|burguers?|hambur|burgas?)$/;
const esPreguntaPorBurgers = (t) => { const c = catalogo.palabrasClave(t); return c.length > 0 && c.every((p) => BURGER.test(p)); };
// Lo que no es bebida, papas, un extra, un combo ni un postre.
const NO_BURGER = /\b(?:combo|promo|papas?|fritas|extra|agua|coca|cola|sprite|fanta|pepsi|gaseosa|cerveza|jugo|lata|nuggets?|brownie|helado|postre|flan|bastones|aros)\b/;
function burgers(ctx, estado) {
  if (!catalogo.cargado()) return sinCatalogo(ctx);
  const lista = catalogo.todos().filter((x) => x.hay && !NO_BURGER.test(nlu.normalizar(x.nombre)));
  if (!lista.length) return carta(ctx);
  recordar(ctx, lista, '');
  return responder(ctx, estado, `Estas son nuestras burgers 🍔\n\n${lista.map((x) => `• ${nombreConPrecio(x)}`).join('\n')}\n\nPara pedir, escribí *pedido* o mandame directo lo que querés.`);
}

const PIDE_DEMORA = /\b(?:tarda|tardan|tardas|demora|demoran|demoras|cuanto tiempo|en cuanto|a que hora llega|a que hora me llega|cuando llega|estan abiertos|estas abierto|esta abierto|abren hoy|atienden hoy|siguen abiertos|ya abrieron|abierto)\b/;

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
  const ctx = { config, clienta, datos, msj, texto: texto.toLowerCase(), entender: (c, ayuda) => entenderEnPaso(c, ayuda) || pedirIA(c) };

  if (nlu.esVolverAlMenu(texto)) {
    ctx.datos = {};
    return menu(ctx, '¡Volvamos al principio!');
  }
  // El carrito del catálogo de WhatsApp Business: se toma como un pedido entero, en cualquier paso.
  if (msj.carrito) return carritoDelCatalogo(ctx);
  const manejadores = {
    inicio, consultando, armando_pedido, eligiendo_producto, eligiendo_peso, pidiendo_nombre, confirmando_pedido,
    eligiendo_entrega, pidiendo_direccion, eligiendo_zona, eligiendo_pago, ofreciendo_extras,
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
  return hay.length ? `${antes}*1 ${hay[0].nombre.toLowerCase()}*${despues}` : '';
}

// El saludo: un local gastronómico agradece como lo haría alguien del local; el resto se presenta como asistente.
// Una hamburguesería habla como el que atiende el mostrador.
function saludo(ctx) {
  const nombre = ctx.config.negocio.nombre;
  if (ctx.config.negocio.rubro === 'hamburgueseria') return `¡Hola! ¿Cómo andás? 👋 Te atendemos de *${nombre}* ${ctx.config.textos.emoji}`;
  return gastro.esGastro(ctx.config) ? `¡Hola! 👋 Gracias por escribir a *${nombre}*.` : `¡Hola! 👋 Soy el asistente de *${nombre}*.`;
}

const sinCatalogo = (ctx) => responder(ctx, 'inicio',
  'Todavía no tengo cargada la lista de precios 😅 Escribí *4* y te responde una persona.');

// Una línea por producto: "Coca 2,25 L — $3.500 ✅" o "… ❌ sin stock".
const lineaProducto = (x) => `• ${nombreConPrecio(x)} ${x.hay ? '✅' : '❌ sin stock'}`;

// ---------- lo que vio en el mensaje anterior ----------
// Los productos que se le acaban de mostrar (una consulta, la carta), para entender el mensaje siguiente.
function recordar(ctx, productos, busqueda) {
  ctx.datos.vistos = productos.slice(0, MAX_CARTA).map((x) => x.gid);
  ctx.datos.buscado = catalogo.palabrasClave(busqueda).join(' ');
}

const ORDINALES = { primera: 1, primero: 1, primer: 1, segunda: 2, segundo: 2, tercera: 3, tercero: 3, tercer: 3, cuarta: 4, cuarto: 4, quinta: 5, quinto: 5 };
// Palabras que dicen "eso que me mostraste" o "lo quiero", sin nombrar un producto.
const SEÑALA = new Set(['esa', 'ese', 'esas', 'esos', 'esta', 'este', 'misma', 'mismo', 'mismas', 'mismos', 'quiero', 'quiero', 'kiero', 'dame',
  'pasame', 'mandame', 'traeme', 'anotame', 'ponele', 'poneme', 'sumame', 'pedime', 'preparame', 'das', 'pasas', 'mandas', 'traes', 'dale',
  'si', 'quisiera', 'queria', 'pido', 'llevo', 'agrego', 'encargo']);
// "ok", "perfecto", "gracias" después de un precio son un gracias, no un pedido: no están acá.
const RELLENO_SEÑA = new Set(['me', 'la', 'lo', 'las', 'los', 'de', 'el', 'porfa', 'por', 'favor', 'entonces', 'una', 'uno', 'un', 'unas', 'unos',
  'y', 'ahi', 'eso', 'esto', 'nomas', 'pedir', 'pedirla', 'pedirlo', 'opcion', 'numero', 'vez', 'ultima', 'ultimo', 'te', 'mas']);

function loQueVio(ctx, gids, buscado, estado) {
  const vistos = gids.map((g) => catalogo.porGid(g)).filter(Boolean);
  if (!vistos.length) return null;
  const norm = nlu.normalizar(ctx.texto).replace(/[?]/g, '');
  const palabras = norm.split(' ').filter(Boolean);
  // "la segunda", "la 2", "la última"
  let orden = null;
  for (const p of palabras) if (ORDINALES[p]) orden = ORDINALES[p];
  if (/\b(?:ultima|ultimo)\b/.test(norm)) orden = vistos.length;
  const nro = norm.match(/^(?:la|el|opcion|numero)\s+(\d{1,2})$/);
  if (nro) orden = Number(nro[1]);
  // "¿cuánto sale?", "¿precio?", sin decir de qué: lo que acaba de ver.
  if (!catalogo.palabrasClave(norm).length && /\b(?:cuanto|precio|precios|sale|salen|cuesta|cuestan|vale|valen)\b/.test(norm) && vistos.length <= 5) {
    recordar(ctx, vistos, buscado);
    return responder(ctx, estado, `${vistos.map(lineaProducto).join('\n')}\n\n${AVISO_PRECIO}\nPara pedir, decime cuántos querés.`);
  }
  // "quiero esa", "pasame 2", "dale, quiero una", "la segunda": pedir lo que vio, sin nombrarlo.
  const cant = numeros.cantidadInicial(palabras.filter((p) => !SEÑALA.has(p) && !['me', 'la', 'lo', 'las', 'los', 'de', 'el', 'y', 'porfa'].includes(p)).join(' '));
  const sinNombre = palabras.every((p) => SEÑALA.has(p) || RELLENO_SEÑA.has(p) || ORDINALES[p] || /^\d{1,2}$/.test(p)
    || ['dos', 'tres', 'cuatro', 'cinco', 'seis'].includes(p) || (cant && p === norm.split(' ').find((x) => x === p)));
  const señala = palabras.some((p) => SEÑALA.has(p)) || orden;
  if (sinNombre && señala && !(palabras.length === 1 && /^\d$/.test(palabras[0]))) {
    const cantidad = Math.min(Math.max((cant && cant.cantidad) || Number((norm.match(/\b(\d{1,2})\b/) || [])[1]) || 1, 1), 99);
    if (orden && !nro) return pedirLoVisto(ctx, [vistos[orden - 1]].filter(Boolean), cantidad);
    if (orden) return pedirLoVisto(ctx, [vistos[orden - 1]].filter(Boolean), 1);
    // "dale" o "quiero" después de la carta entera: arranca el pedido como siempre.
    if (vistos.length > 5) return palabras.some((p) => ['dale', 'si', 'quiero', 'pido'].includes(p)) ? empezarPedido(ctx) : null;
    // "dame esa" con la burger y su combo a la vista: la burger (como si la hubiera nombrado).
    return pedirLoVisto(ctx, preferidos(ctx, buscado, vistos), cantidad);
  }
  // "y la doble?", "¿y en combo?", "la doble": lo mismo que buscó, con esto. "bacon simple" → "y la doble?" es "bacon doble":
  // si con todo no hay nada, se va dejando lo último que había dicho.
  if (buscado && palabras.length <= 5 && /^(?:y|la|el|las|los|en|con|sin|de|tenes|tienen|hay)\b/.test(norm) && catalogo.palabrasClave(norm).length) {
    const nuevo = catalogo.palabrasClave(norm).join(' ');
    const dicho = buscado.split(' ');
    let r = [];
    for (let k = dicho.length; k > 0 && !r.length; k--) r = catalogo.buscar(`${dicho.slice(0, k).join(' ')} ${nuevo}`, 5, sinonimos(ctx)).resultados;
    if (r.length) {
      recordar(ctx, r, `${buscado} ${norm}`);
      return responder(ctx, estado, `${r.map(lineaProducto).join('\n')}\n\n${AVISO_PRECIO}\nPara pedir, decime cuántos querés.`);
    }
  }
  return null;
}

// Arranca el pedido con lo que vio: si es uno, anotado; si son varios, ¿cuál?
function pedirLoVisto(ctx, productos, cantidad) {
  if (!productos.length) return null;
  if (gastro.pausada(ctx.config)) return cocinaPausada(ctx);
  ctx.datos = { items: [] };
  if (productos.length > 1) return preguntarCual(ctx, productos, cantidad, [encabezadoPedido(ctx)]);
  const r = sumar(ctx, productos[0], { cantidad });
  return responder(ctx, 'armando_pedido', `${encabezadoPedido(ctx)}\n\n${r.nota}\n\n¿Algo más? Si no, escribí *listo*.`);
}

// ---------- inicio: consultas ----------
const PIDE_CARTA = /\b(?:catalogo|carta|que tienen hoy|que hay hoy|para comer|que venden|que ofrecen)\b|^(?:que|q) (?:tienen|tenes|hay)$/;

// "hola", "buenass", "holaaa, buenas noches": solo un saludo (con las letras estiradas que se escriben en el chat).
const PALABRAS_SALUDO = new Set(['hola', 'ola', 'holis', 'buenas', 'buen', 'buenos', 'dia', 'dias', 'tardes', 'noches', 'que', 'tal',
  'como', 'va', 'andas', 'estas', 'estan', 'onda', 'hey', 'ey', 'gente', 'chicos', 'todo', 'bien']);
function esSoloSaludo(texto) {
  const palabras = nlu.normalizar(texto).replace(/([a-z])\1+/g, '$1').split(' ').filter(Boolean);
  return palabras.length > 0 && ['hola', 'ola', 'holis', 'buenas', 'buen', 'buenos', 'hey', 'ey'].includes(palabras[0])
    && palabras.every((p) => PALABRAS_SALUDO.has(p));
}
const PIDE_PEDIDO = ['pedido', 'pedir', 'pedirte', 'pedirle', 'pedirles', 'hacer un pedido', 'quiero pedir', 'encargar', 'encargo', 'reservar'];
const PIDE_PRECIO = ['precio', 'precios', 'cuanto', 'sale', 'cuesta', 'vale', 'hay', 'tienen', 'tenes', 'queda', 'quedan', 'stock'];

// Después del "1" (consultar precios) cada mensaje es un producto: lo que no está dice "no encontré" (no el menú) y se
// sigue consultando sin volver a poner "1". Lo demás (las otras opciones, "pedido", "gracias", "hola") anda como en inicio.
const consultando = (ctx) => inicio(ctx, 'consultando');

function inicio(ctx, estado = 'inicio') {
  let t = ctx.texto;
  const sinEntender = ctx.datos.sinEntender || 0;
  delete ctx.datos.sinEntender;
  if (!t || nlu.esRisa(t)) return [];
  // Lo que le mostramos en el mensaje anterior vale solo para este: "quiero esa", "pasame 2", "la segunda", "y la doble?".
  const { vistos, buscado: antes } = ctx.datos;
  delete ctx.datos.vistos;
  delete ctx.datos.buscado;
  const conContexto = vistos && vistos.length ? loQueVio(ctx, vistos, antes || '', estado) : null;
  if (conContexto) return conContexto;
  const soloSaludo = esSoloSaludo(t);
  if (nlu.esCortesia(t) && !soloSaludo) return responder(ctx, 'inicio', '¡Gracias a vos! 😊 Cualquier cosa escribime *hola*.');
  const apurado = apuro(ctx);
  if (apurado) return apurado;
  if (soloSaludo) return menu(ctx, saludo(ctx));
  // Las opciones del menú como las escriba ("1.", "el 1", "opción 2", "uno")
  const op = nlu.opcionMenu(t);
  if (op && op <= 4) t = String(op);

  if (t === '1' && gastro.esGastro(ctx.config)) return carta(ctx);
  if (t === '1') return responder(ctx, 'consultando', `Decime qué producto buscás y te paso el precio y si hay ${ctx.config.textos.emoji}\n(por ejemplo: *coca*, *pan lactal*)`);
  if (t === '2') return empezarPedido(ctx);
  if (t === '3' && gastro.esGastro(ctx.config)) return horariosGastro(ctx);
  if (t === '3') return faq.conPin(responder(ctx, 'inicio', faq.ubicacionYHorarios(ctx.config)), ctx.config);
  if (t === '4') return derivarAHumano(ctx, '(pidió hablar con una persona)');

  const norm = nlu.normalizar(t);
  const tokens = norm.split(' ');
  const inter = nlu.interpretar(t);
  // "hola, ¿me podés cortar 200 de jamón, 1/4 de queso y 100 de salame?": el pedido entero en el primer mensaje.
  const enMensaje = pedidoEnElMensaje(ctx);
  if (enMensaje) return enMensaje;
  // "¿me pasás el catálogo?", "¿qué tienen en la carta?": la carta (o el link del catálogo de WhatsApp).
  // "¿qué tienen para comer?", "¿me pasás el menú?": en un local gastronómico el menú es la carta.
  if (gastro.esGastro(ctx.config) && (PIDE_CARTA.test(norm) || (/\bmenu\b/.test(norm) && norm !== 'menu'))) return carta(ctx);
  // "¿cuánto tarda?", "¿están abiertos?": si está abierto y en cuánto llega.
  if (gastro.esGastro(ctx.config) && PIDE_DEMORA.test(norm)) {
    if (/\babiert/.test(norm)) return horariosGastro(ctx);
    return responder(ctx, 'inicio', `${textoAbierto(ctx.config)}\nCuando quieras armar el pedido, escribime *pedido*.`);
  }
  // "¿puedo pasar a buscarlo?" en un local que solo hace envíos.
  if (gastro.esGastro(ctx.config) && PIDE_RETIRO.test(norm) && !gastro.formas(ctx.config).some((f) => !f.envio)) {
    return responder(ctx, 'inicio', `Por ahora solo hacemos envíos 🛵${porDefecto(ctx).envios.replace(/^¡Sí, te lo llevamos! 🛵/, '')}`);
  }
  // "¿qué hamburguesas tienen?" en una hamburguesería: todas las burgers, aunque no digan "hamburguesa" en el nombre.
  if (ctx.config.negocio.rubro === 'hamburgueseria' && esPreguntaPorBurgers(t)) return burgers(ctx, estado);
  if (PIDE_PEDIDO.some((k) => nlu.contiene(norm, tokens, k))) return empezarPedido(ctx);

  // Lo que pregunta en el mismo mensaje va antes que pasarlo a una persona: "¿alguien me atiende? quiero saber si tienen
  // leche" se contesta con la leche (y la opción de hablar con alguien).
  const buscado = catalogo.palabrasClave(t).length && catalogo.cargado() ? catalogo.buscar(t, 5, sinonimos(ctx)) : null;
  // Envíos, cómo se paga, horarios, ubicación y las preguntas que cargó el negocio. Las del negocio van antes que pasarlo a
  // una persona: si el local cargó qué contestar a "¿sos un bot?", lo contesta él (si no, sigue yendo a una persona).
  const tm = nlu.tema(ctx.config, t);
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
      recordar(ctx, resultados, t);
      return responder(ctx, estado, `${resultados.map(lineaProducto).join('\n')}${mas}\n\n${AVISO_PRECIO}\nPara pedir, escribí *pedido*.${persona}`);
    }
    // Preguntó por algo que no está (o está consultando): no es que no lo entendimos, pero queda anotado (puede ser
    // una palabra que le falta al diccionario).
    if (estado === 'consultando' && inter.intencion !== 'saludo') {
      const ia = pedirIA(ctx);
      if (ia) return ia;
      anotarNoEntendido(ctx);
      return responder(ctx, estado, `No encontré "${ctx.msj.texto.trim()}" 🤔 Probá con otro nombre, escribí *4* para preguntarle a una persona o *menú* para ver las opciones.`);
    }
    if (pregunta && inter.intencion !== 'saludo') {
      // La IA va antes que "lo más parecido": entiende mejor lo que quiso decir ("las que tienen panceta, las grandes").
      const ia = pedirIA(ctx);
      if (ia) return ia;
      const parecidos = catalogo.parecidos(t, 5, sinonimos(ctx));
      anotarNoEntendido(ctx);
      if (parecidos.length) {
        recordar(ctx, parecidos, t);
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
  // Lo que no se entendió: primero la IA (si está prendida); si tampoco, queda anotado y a la segunda seguida, una persona en
  // vez del menú otra vez.
  const ia = pedirIA(ctx);
  if (ia) return ia;
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
const VERBO_PEDIDO = '(?:me )?(?:podes |podrias |puedes |vas a )?(?:cortar|cortame|cortas|preparar|preparame|preparas|separar|separame|separas|guardar|guardame|guardas|anotar|anotame|anotas|dar|dame|das|mandar|mandame|mandas|mandan|haceme|hacenme|me haces|me hacen|quiero|kiero|qiero|quisiera|queria|keria|necesito|me llevo|llevo|encargar|encargo|pedirte|pedirle|pedirles|pedir|pido|traeme|me traes|tirame|tirate)';
const SALUDO_INICIAL = /^(?:(?:hola+|holis|buenas+|buen dia|buenos dias|noches|tardes|dias|che|como va|como andas|como estas|que tal|disculpa|perdon|gente)[\s,!.¡¿?]*)+/;
const RELLENO_FINAL = /[\s,.!?¿¡]*(?:(?:porfa|por favor|gracias|plis|please|dale)[\s,.!?¿¡]*)*$/;

// Si el mensaje es un pedido ("hola, ¿me podés cortar 200 de jamón y 1/4 de queso?", "quiero 2 cocas y 1/4 de jamón"),
// arranca el pedido con todo anotado. Hace falta un verbo de pedido o que algún renglón traiga cantidad o peso, y que
// algún producto exista; "¿cuánto sale el 1/4 de jamón?" o "¿tienen coca?" siguen siendo consultas.
function pedidoEnElMensaje(ctx) {
  if (!catalogo.cargado()) return null;
  let t = (ctx.msj.texto || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(SALUDO_INICIAL, '');
  const norm = nlu.normalizar(t);
  if (/\b(?:cuanto|cuanta|precio|precios|sale|salen|cuesta|cuestan|vale|valen)\b/.test(norm)) return null;
  // "quiero pedirte un combo": puede haber más de un verbo seguido.
  // "… y 2 sprite. Para Belgrano 250": la dirección al final del mensaje (solo si el local lleva).
  let direccion = null;
  const conDir = gastro.esGastro(ctx.config) && gastro.formas(ctx.config).some((f) => f.envio) && t.match(DIRECCION_AL_FINAL);
  if (conDir && !['anotar', 'elegir'].includes(leerLineaSola(ctx, conDir[1]).tipo)) {
    const original = (ctx.msj.texto || '').match(new RegExp(`(.{${conDir[1].length}})\\s*$`));
    direccion = (original ? original[1] : conDir[1]).trim().replace(/[.!]+$/, '');
    t = t.slice(0, conDir.index);
  }
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
  const productos = leidas.filter(esProducto);
  const conCantidad = leidas.some(({ l }) => numeros.pesoInicial(l) || numeros.cantidadInicial(l));
  if (!productos.length || !(verbo || conCantidad)) return null;
  if (gastro.pausada(ctx.config)) return cocinaPausada(ctx);
  ctx.datos = { items: [] };
  if (direccion) ctx.datos.direccion = direccion;
  const r = anotarVarias(ctx, lineas, []);
  r[0].texto = `${encabezadoPedido(ctx)}\n\n${r[0].texto}`;
  return r;
}

const DIRECCION_AL_FINAL = /[\s,.;]+(?:para|a|en|envialo a|mandalo a|llevalo a|traelo a|direccion:?|dir:?|a la calle|en la calle)\s+((?:calle\s+|av\.?\s+|avenida\s+)?[a-zñ][a-zñ .]{2,40}\s\d{1,5}\b[^,]*)$/;

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
  const lineas = Array.isArray(ctx.msj.carrito) ? ctx.msj.carrito : [];
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
  recordar(ctx, hay.slice(0, MAX_CARTA), '');
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
  const r = leerLineaSola(ctx, linea);
  if (!['no_encontre', 'parecidos'].includes(r.tipo)) return r;
  // "1 clásica sin cebolla", "2 bacon, una bien cocida": lo de después es una aclaración para la cocina. Se prueba recién
  // cuando la línea entera no es un producto, así "Agua sin gas" sigue siendo el agua.
  const m = linea.match(ACLARACION);
  if (!m || !m.index) return r;
  const base = leerLineaSola(ctx, linea.slice(0, m.index));
  if (!['anotar', 'elegir', 'pesar'].includes(base.tipo)) return r;
  return { ...base, aclaracion: linea.slice(m.index).replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '').replace(/^pero\s+/i, '').slice(0, 80) };
}
const ACLARACION = /[\s,;-]+(?:pero\s+)?(?:sin|bien|poco|muy|jugosa|jugoso|a punto|con extra|extra|aparte|cortad[ao]|sin nada|que (?:sea|venga)|con mucho|con poco|una de (?:ellas|las)|la de|el de)\b/i;

// Entre varios que calzan en un local gastronómico, lo que pidió de verdad: un combo o una promo solo si lo nombró ("una clásica" es la hamburguesa,
// no el combo), y la versión base si las otras son la misma con algo más ("coca" es la Coca Cola, no la Coca Cola Zero).
function preferidos(ctx, busqueda, resultados) {
  const dichas = new Set(catalogo.palabrasClave(busqueda));
  const palabras = (x) => nlu.normalizar(x.nombre).split(' ').filter(Boolean);
  // Solo en un local gastronómico: un almacén pregunta cuál (es lo que pidió el dueño del primer almacén).
  if (!gastro.esGastro(ctx.config)) return resultados;
  let r = resultados;
  if (![...dichas].some((p) => /^(?:combo|combos|promo|promos|promocion)$/.test(p))) {
    const sueltos = r.filter((x) => !palabras(x).some((p) => /^(?:combo|promo)$/.test(p)));
    if (sueltos.length) r = sueltos;
  }
  const base = r.filter((x) => r.every((y) => y === x || palabras(x).every((p) => palabras(y).includes(p))));
  if (base.length === 1) return base;
  // "2 papas fritas" son las Papas fritas, no las Papas con cheddar y bacon: el que trae a lo sumo una palabra que no dijo,
  // cuando los otros traen al menos dos más que él ("fritas" no cuenta: es como se dice papas).
  const RELLENO = new Set(['con', 'y', 'de', 'la', 'el', 'x', 'ml', 'l', 'g', 'kg', 'cc', 'fritas']);
  const deMas = r.map((x) => palabras(x).filter((w) => !RELLENO.has(w) && !/^\d/.test(w)
    && ![...dichas].some((p) => w === p || (p.length >= 3 && w.startsWith(p.replace(/s$/, ''))))).length);
  const min = Math.min(...deMas);
  if (min <= 1 && deMas.filter((n) => n < min + 2).length === 1) return [r[deMas.indexOf(min)]];
  return r;
}

function leerLineaSola(ctx, linea) {
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
  if (resultados.length > 1) resultados = preferidos(ctx, busqueda, resultados);
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
  const quitado = quitar(ctx, texto) || aclararUltimo(ctx, texto) || cambiarUltimo(ctx, texto);
  if (quitado) return responder(ctx, 'armando_pedido', `${quitado}\n\n¿Algo más? Si no, escribí *listo*.`);
  // "¿tienen cerveza?" mientras arma el pedido es una pregunta, no un renglón: si la contesta una pregunta de siempre o del
  // negocio, se contesta y no se anota nada. Con una cantidad ("¿me sumás 2 cervezas?") sí es un renglón.
  if (esPreguntaSinCantidad(texto)) {
    const aparte = entenderEnPaso(ctx, '¿Algo más? Si no, escribí *listo*.');
    if (aparte) return aparte;
  }
  const lineas = separarLineas(texto);
  if (lineas.length > 1) return anotarVarias(ctx, lineas, []);

  const r = leerLinea(ctx, texto);
  if (r.tipo === 'no_encontre' || r.tipo === 'parecidos') {
    // No es un producto: ¿es una pregunta de siempre ("¿hacen envíos?", "¿hasta qué hora están?")? Se contesta sin perder
    // lo anotado. Va después de buscar en el catálogo, así una palabra de un producto nunca se confunde con una pregunta.
    const aparte = entenderEnPaso(ctx, '¿Algo más? Si no, escribí *listo*.');
    if (aparte) return aparte;
    // "jamón y queso": dos productos, si cada uno existe por separado.
    const partes = texto.split(/\s+y\s+/i);
    if (partes.length > 1 && partes.every((x) => !['no_encontre', 'parecidos', 'nada'].includes(leerLinea(ctx, x).tipo))) return anotarVarias(ctx, partes, []);
    if (r.tipo === 'parecidos') return preguntarCual(ctx, r.resultados, r.cantidad, [noJustoAsi(r.busqueda)], null, r.aclaracion);
    const ia = pedirIA(ctx);
    if (ia) return ia;
    anotarNoEntendido(ctx);
    return responder(ctx, 'armando_pedido', `No encontré "${r.busqueda.trim()}" 🤔 ${mirarCarta(ctx)}Probá con otro nombre, o *listo* para terminar.`);
  }
  if (r.tipo === 'nada') return noEntendi(ctx, 'Decime qué producto querés (ej: *2 coca*), o *listo* para terminar.');
  if (r.tipo === 'cantidad_mala') return responder(ctx, 'armando_pedido', 'Esa cantidad no la puedo anotar 😅 Probá de nuevo (ej: *2 coca*).');
  if (r.tipo === 'paquete') return responder(ctx, 'armando_pedido', `${textoPaquete(r.producto)} ¿Cuántos querés? (ej: *1 ${catalogo.palabrasClave(r.producto.nombre)[0]}*)`);
  if (r.tipo === 'pesar') return preguntarPeso(ctx, r.producto, []);
  if (r.tipo === 'elegir') return preguntarCual(ctx, r.resultados, r.cantidad, [], r.gramos, r.aclaracion);
  return agregar(ctx, r.producto, r);
}

// "sacame la coca", "sin las papas", "borrá una clásica", "al final no quiero la coca": se saca del pedido (con un número, esa
// cantidad). Devuelve qué se hizo, o null si no es eso o no hay nada así en el pedido.
const QUITAR = /^(?:al final\s+)?(?:sacame|saca|sacale|sacar|saque|quita|quitame|quitale|quitar|borra|borrame|borrar|elimina|eliminame|cancela|cancelame|no quiero|ya no quiero|sin)\s+(.+)$/;
function quitar(ctx, texto) {
  const items = ctx.datos.items || [];
  const m = nlu.normalizar(texto).match(QUITAR);
  if (!m || !items.length) return null;
  const { cantidad, busqueda, como } = leerCantidad(m[1]);
  const claves = catalogo.palabrasClave(busqueda);
  if (!claves.length) return null;
  const palabras = (x) => nlu.normalizar(x.nombre).split(' ');
  const calza = items.filter((x) => claves.every((p) => palabras(x).some((w) => w === p || (p.length >= 3 && w.startsWith(p.replace(/s$/, ''))))));
  // "sin cebolla" es una aclaración, no sacar algo; "sacame la coca" sin coca en el pedido se dice.
  if (!calza.length && !/^sin\b/.test(m[0]) && catalogo.buscar(busqueda, 1, sinonimos(ctx)).resultados.length) return `No tenés ${busqueda.trim()} en el pedido 🙂`;
  if (calza.length !== 1) return null;
  const x = calza[0];
  if (como && !x.gramos && cantidad < x.cantidad) {
    x.cantidad -= cantidad;
    return `Listo, saqué ${cantidad}. Quedan ${cuantoDe(x)} 👍`;
  }
  ctx.datos.items = items.filter((y) => y !== x);
  const quedan = ctx.datos.items.length ? '' : '\nEl pedido quedó vacío.';
  return `Listo, saqué ${cuantoDe(x)} 👍${quedan}`;
}

// "sin cebolla", "que sea bien cocida", "uno sin tomate" solos, después de anotar: son para lo último que pidió que no es para
// tomar (si no es un producto). "Uno …" con varios anotados parte el renglón: 1 con la aclaración y el resto como estaba.
const SOLO_ACLARACION = /^(?:pero\s+|y\s+)?(?:(?:uno|una|1|a uno|a una)\s+(?:de (?:ellos|ellas|esos|esas)\s+)?)?(?:sin|bien|poco|muy|con extra|que sea|que venga|jugosa|jugoso|a punto|con mucho|con poco)\b/;
const PARA_TOMAR = /\b(?:coca|cola|sprite|fanta|pepsi|seven|agua|gaseosa|cerveza|birra|jugo|lata|limonada)\b/;
function aclararUltimo(ctx, texto) {
  const items = (ctx.datos.items || []).filter((x) => !x.gramos);
  const norm = nlu.normalizar(texto);
  if (!items.length || !SOLO_ACLARACION.test(norm) || ['anotar', 'elegir'].includes(leerLineaSola(ctx, texto).tipo)) return null;
  const comida = items.filter((x) => !PARA_TOMAR.test(nlu.normalizar(x.nombre)));
  const x = (comida.length ? comida : items)[(comida.length ? comida : items).length - 1];
  const limpio = texto.trim().replace(/^(?:pero|y)\s+/i, '').replace(/^(?:a\s+)?(?:uno|una|1)\s+(?:de (?:ellos|ellas|esos|esas)\s+)?/i, '').replace(/[.!]+$/, '');
  const aclaracion = [x.aclaracion, limpio].filter(Boolean).join(', ').slice(0, 80);
  if (/^(?:pero\s+|y\s+)?(?:a\s+)?(?:uno|una|1)\b/.test(norm) && x.cantidad > 1) {
    x.cantidad -= 1;
    const uno = { ...x, cantidad: 1, aclaracion };
    ctx.datos.items.splice(ctx.datos.items.indexOf(x) + 1, 0, uno);
    return `Anotado: de esos, 1 ${limpio} ✍️`;
  }
  x.aclaracion = aclaracion;
  return `Anotado: ${cuantoDe(x)} ✍️`;
}

// Lo último que anotó: "otra", "otra más", "una más", "otra igual", "2 más" (suma) y "que sean 3", "mejor 3", "poneme 3"
// (cambia la cantidad).
function cambiarUltimo(ctx, texto) {
  const items = (ctx.datos.items || []).filter((x) => !x.gramos);
  if (!items.length) return null;
  const norm = nlu.normalizar(texto);
  const x = items[items.length - 1];
  const sumarle = norm.match(/^(?:y\s+)?(?:otra|otro|una|uno|(\d{1,2}|dos|tres|cuatro|cinco))\s*(?:mas|igual|iguales|de esas|de esos|de la misma|del mismo|mas igual)?(?:\s+(?:porfa|por favor))?$/);
  const otraVez = /^(?:otra|otro|lo mismo|otra igual|otro igual|otra mas|otro mas|una mas|uno mas|repeti|repetila|repetilo)$/.test(norm);
  if (sumarle && (otraVez || /\b(?:mas|igual|iguales)\b/.test(norm))) {
    const n = sumarle[1] ? (Number(sumarle[1]) || numeros.cantidadInicial(`${sumarle[1]} x`)?.cantidad || 1) : 1;
    x.cantidad = Math.min(999, x.cantidad + n);
    return `Anotado: ${cuantoDe(x)} — ${catalogo.plata(subtotal(x))} ✍️`;
  }
  if (otraVez) { x.cantidad = Math.min(999, x.cantidad + 1); return `Anotado: ${cuantoDe(x)} — ${catalogo.plata(subtotal(x))} ✍️`; }
  const fija = norm.match(/^(?:que sean|mejor|poneme|ponele|cambialo a|cambiala a|hacelo|hacela|son|en realidad son|eran)\s+(\d{1,3}|dos|tres|cuatro|cinco|seis)$/);
  if (fija) {
    const n = Number(fija[1]) || numeros.cantidadInicial(`${fija[1]} x`)?.cantidad;
    if (!n) return null;
    x.cantidad = Math.min(999, n);
    return `Listo, ${cuantoDe(x)} — ${catalogo.plata(subtotal(x))} ✍️`;
  }
  return null;
}

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
    const aclarado = aclararUltimo(ctx, linea);
    if (aclarado) { notas.push(`✍️ ${aclarado.replace(/^Anotado: | ✍️$/g, '')}`); continue; }
    const r = leerLinea(ctx, linea);
    if (r.tipo === 'nada') continue;
    if (r.tipo === 'cantidad_mala') notas.push(`❌ "${linea}": esa cantidad no la puedo anotar`);
    else if (r.tipo === 'no_encontre') { notas.push(`❌ No encontré "${r.busqueda.trim()}"`); anotarNoEntendido({ ...ctx, msj: { texto: linea } }); }
    else if (r.tipo === 'paquete') notas.push(`📦 ${textoPaquete(r.producto)}: decime cuántos`);
    else if (r.tipo === 'anotar') notas.push(sumar(ctx, r.producto, r).nota);
    else if (r.tipo === 'parecidos') {
      ctx.datos.pendientes = resto;
      return preguntarCual(ctx, r.resultados, r.cantidad, [...notas, noJustoAsi(r.busqueda)], null, r.aclaracion);
    } else {
      ctx.datos.pendientes = resto;
      return r.tipo === 'pesar' ? preguntarPeso(ctx, r.producto, notas) : preguntarCual(ctx, r.resultados, r.cantidad, notas, r.gramos, r.aclaracion);
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

function preguntarCual(ctx, resultados, cantidad, notas, gramos, aclaracion) {
  ctx.datos.opciones = resultados.map((x) => x.gid);
  ctx.datos.cantidad = cantidad;
  if (gramos) ctx.datos.gramos = gramos; else delete ctx.datos.gramos;
  if (aclaracion) ctx.datos.aclaracion = aclaracion; else delete ctx.datos.aclaracion;
  const antes = notas.length ? `${notas.join('\n')}\n\n` : '';
  return responder(ctx, 'eligiendo_producto', `${antes}¿Cuál de estos?\n\n${listaOpciones(resultados)}\n\nRespondé con el número o el nombre, o *0* para buscar otro.`);
}
const listaOpciones = (resultados) => resultados.map((x, i) => `*${i + 1}* — ${nombreConPrecio(x)}${x.hay ? '' : ' (sin stock)'}`).join('\n');

// La opción que nombró ("la doble", "la zero", "el combo", "la común"): la única con más palabras dichas que las demás.
function opcionPorNombre(texto, productos) {
  const dichas = catalogo.palabrasClave(texto).filter((p) => !['la', 'el', 'de', 'quiero', 'esa', 'ese'].includes(p));
  if (!dichas.length) return null;
  const palabras = (x) => nlu.normalizar(x.nombre).split(' ');
  const puntos = productos.map((x) => dichas.filter((p) => palabras(x).some((w) => w === p || (p.length >= 3 && w.startsWith(p)))).length);
  const max = Math.max(...puntos);
  if (max > 0 && puntos.filter((n) => n === max).length === 1) return productos[puntos.indexOf(max)];
  // "la común", "sola", "la normal": la que no es combo ni trae algo de más.
  if (/\b(?:comun|normal|sola|solo|sin combo|nada mas|la primera|el primero)\b/.test(nlu.normalizar(texto))) {
    const base = productos.filter((x) => productos.every((y) => y === x || palabras(x).every((p) => palabras(y).includes(p))));
    if (base.length === 1) return base[0];
  }
  return null;
}

function eligiendo_producto(ctx) {
  const opciones = (ctx.datos.opciones || []).map((gid) => catalogo.porGid(gid)).filter(Boolean);
  const limpiar = () => { delete ctx.datos.opciones; delete ctx.datos.cantidad; delete ctx.datos.gramos; delete ctx.datos.aclaracion; };
  if (ctx.texto === '0' || nlu.esNo(ctx.texto) || /^(?:ninguno|ninguna|ningun|otro|otra)$/.test(nlu.normalizar(ctx.texto))) { limpiar(); return seguir(ctx, []); }
  const norm = nlu.normalizar(ctx.texto);
  // "y unas papas", "también 2 cocas": es otra cosa para el pedido, no la respuesta.
  const otraCosa = /^(?:y|tambien|ademas|sumale|sumame|agregale|agregame)\b/.test(norm) || (/^(?:\d+|un|una|unos|unas|dos|tres)\s+\S/.test(norm) && !nlu.opcionMenu(ctx.texto));
  const n = otraCosa ? null : (nlu.opcionMenu(ctx.texto) || (/^\d+$/.test(norm) ? Number(norm) : null));
  const producto = otraCosa ? null : ((n && n <= opciones.length ? opciones[n - 1] : null) || opcionPorNombre(ctx.msj.texto || '', opciones));
  if (!producto) return otraCosaAlElegir(ctx, opciones);
  const { cantidad = 1, gramos, aclaracion } = ctx.datos;
  limpiar();
  if (catalogo.esPesable(producto) && !gramos) return preguntarPeso(ctx, producto, []);
  const pedido = catalogo.esPesable(producto) ? { gramos } : { cantidad: Math.min(cantidad, 999), aclaracion };
  if (ctx.datos.pendientes) return anotarVarias(ctx, ctx.datos.pendientes, [sumar(ctx, producto, pedido).nota]);
  return agregar(ctx, producto, pedido);
}

// Mientras tiene que elegir, escribió otra cosa: "listo" (le falta elegir), otro producto ("y una coca": se anota y se
// vuelve a preguntar), una pregunta (se contesta). Solo lo que no se entiende cuenta como no entendido.
function otraCosaAlElegir(ctx, opciones) {
  const norm = nlu.normalizar(ctx.texto);
  const reAsk = (antes) => responder(ctx, 'eligiendo_producto', `${antes}¿Cuál de estos querés?\n\n${listaOpciones(opciones)}\n\nRespondé con el número, o *0* si no va.`);
  if (TERMINAR.includes(norm) && norm !== 'no') return reAsk('Antes de cerrar me falta una cosa 🙂 ');
  const lineas = separarLineas(ctx.msj.texto || '');
  const leidas = lineas.map((l) => ({ l, r: leerLinea(ctx, l) }));
  if (leidas.some(({ r }) => ['anotar', 'elegir', 'pesar'].includes(r.tipo))) {
    const notas = [];
    const despues = [];
    for (const { l, r } of leidas) {
      if (r.tipo === 'anotar') notas.push(sumar(ctx, r.producto, r).nota);
      else if (r.tipo === 'elegir' || r.tipo === 'pesar') despues.push(l);
    }
    if (despues.length) ctx.datos.pendientes = [...despues, ...(ctx.datos.pendientes || [])];
    return reAsk(notas.length ? `${notas.join('\n')}\n\nY de lo anterior, ` : '');
  }
  return noEntendi(ctx, `Decime cuál con el número 🙂\n\n${listaOpciones(opciones)}\n\n(o *0* si no va)`);
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
const cuantoDe = (x) => (x.gramos ? `${numeros.textoPeso(x.gramos)} de ${catalogo.nombreCorto(x)}` : `${x.cantidad} × ${x.nombre}${x.aclaracion ? ` (${x.aclaracion})` : ''}`);
// Las aclaraciones para la cocina viajan en la nota del pedido: "1 × Hamburguesa Clásica: sin cebolla".
const notaDe = (items) => items.filter((x) => x.aclaracion).map((x) => `${x.cantidad} × ${x.nombre}: ${x.aclaracion}`).join('\n');
const subtotal = (x) => (x.gramos ? catalogo.precioDeGramos(x.precioCentavos, x.gramos) : x.precioCentavos * x.cantidad);

// Suma el producto al pedido (si hay stock y entra): { cantidad } por unidad o { gramos } si se pesa. Devuelve si se
// anotó y la línea para contarlo.
function sumar(ctx, producto, { cantidad, gramos, aclaracion }) {
  if (!producto.hay) return { ok: false, nota: `❌ No hay stock de *${catalogo.esPesable(producto) ? catalogo.nombreCorto(producto) : producto.nombre}* ahora 😕` };
  const items = ctx.datos.items || [];
  const nuevo = gramos
    ? { gid: producto.gid, nombre: producto.nombre, gramos, precioCentavos: producto.precioCentavos }
    : { gid: producto.gid, nombre: producto.nombre, cantidad, precioCentavos: producto.precioCentavos, ...(aclaracion ? { aclaracion } : {}) };
  // Con otra aclaración es otro renglón ("1 clásica" y "1 clásica sin cebolla").
  const ya = items.find((x) => x.gid === producto.gid && !!x.gramos === !!gramos && (x.aclaracion || '') === (aclaracion || ''));
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
  if (gastro.ofreceExtras(c) && !d.extrasOfrecidos) {
    d.extrasOfrecidos = true;
    const extras = gastro.extrasQueFaltan(d.items, catalogo.todos());
    if (extras.length) {
      d.extras = extras.map((x) => x.gid);
      const lista = extras.map((x, i) => `*${i + 1}* — ${nombreConPrecio(x)}`).join('\n');
      const dos = extras.length > 1 ? `\n*${extras.length + 1}* — Las dos` : '';
      return responder(ctx, 'ofreciendo_extras', `¿Le sumamos algo? 🍟🥤\n\n${lista}${dos}\n*0* — No, así está bien`);
    }
  }
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

// Papas, bebida o las dos (ver `siguienteGastro`): lo elegido se suma de a uno y sigue el pedido. "No" o "0" sigue sin nada.
function ofreciendo_extras(ctx) {
  const productos = (ctx.datos.extras || []).map((gid) => catalogo.porGid(gid)).filter(Boolean);
  delete ctx.datos.extras;
  const norm = nlu.normalizar(ctx.texto);
  const seguirCon = (elegidos, antes = []) => {
    const notas = [...antes, ...elegidos.map((x) => sumar(ctx, x, { cantidad: 1 }).nota)];
    const r = siguienteGastro(ctx);
    if (notas.length) r[0].texto = `${notas.join('\n')}\n\n${r[0].texto}`;
    return r;
  };
  if (ctx.texto === '0' || nlu.esNo(ctx.texto) || /^(?:no|nada|asi esta bien|asi nomas|esta bien asi|solo eso|eso nomas)\b/.test(norm)) return seguirCon([]);
  const n = nlu.opcionMenu(ctx.texto) || numerosDe(ctx.texto)[0];
  if (/\b(?:las dos|ambas|los dos|todo|las 2|los 2)\b/.test(norm) || (productos.length > 1 && n === productos.length + 1)) return seguirCon(productos);
  if (n >= 1 && n <= productos.length) return seguirCon([productos[n - 1]]);
  // "unas papas", "si, la coca", "papas y bebida": por el nombre o por lo que es.
  const claves = catalogo.palabrasClave(ctx.texto);
  const porNombre = productos.filter((x) => claves.some((p) => nlu.normalizar(x.nombre).split(' ').includes(p))
    || (/\b(?:papa|papas|papitas|fritas)\b/.test(norm) && /papa|frita/i.test(x.nombre))
    || (/\b(?:bebida|gaseosa|tomar|bebible)\b/.test(norm) && !/papa|frita/i.test(x.nombre)));
  if (porNombre.length) return seguirCon(porNombre);
  // "sí" con dos opciones: ¿cuál?
  if (nlu.esSi(ctx.texto) && productos.length > 1) {
    ctx.datos.extras = productos.map((x) => x.gid);
    return responder(ctx, 'ofreciendo_extras', `¿Qué te sumo? 🙂\n\n${productos.map((x, i) => `*${i + 1}* — ${nombreConPrecio(x)}`).join('\n')}\n*${productos.length + 1}* — Las dos`);
  }
  if (nlu.esSi(ctx.texto)) return seguirCon(productos);
  // Otra cosa de la carta ("una sprite"): se suma eso.
  const otras = separarLineas(ctx.msj.texto || '').map((l) => leerLinea(ctx, l)).filter((r) => r.tipo === 'anotar');
  if (otras.length) return seguirCon([], otras.map((r) => sumar(ctx, r.producto, r).nota));
  // Siguió de largo (mandó la dirección, el nombre…): es un no, y el mensaje es para el paso que sigue, si parece eso.
  const proximo = siguientePaso({ ...ctx, datos: { ...ctx.datos, entrega: ctx.datos.entrega || (gastro.formas(ctx.config).length === 1 ? gastro.formas(ctx.config)[0].clave : null) } });
  const texto = (ctx.msj.texto || '').trim();
  const pareceEso = { pidiendo_direccion: /[a-záéíóúñ].*\d|\d.*[a-záéíóúñ]/i.test(texto), pidiendo_nombre: /^[a-záéíóúñü' ]{2,30}$/i.test(texto) && texto.split(/\s+/).length <= 3 }[proximo];
  if (pareceEso) {
    siguienteGastro(ctx);
    return { pidiendo_direccion, pidiendo_nombre }[proximo](ctx);
  }
  // Ni eso: la IA, o se vuelve a preguntar.
  ctx.datos.extras = productos.map((x) => x.gid);
  return noEntendi(ctx, `Perdón, no te entendí 😅 ¿Le sumamos algo?\n\n${productos.map((x, i) => `*${i + 1}* — ${nombreConPrecio(x)}`).join('\n')}${productos.length > 1 ? `\n*${productos.length + 1}* — Las dos` : ''}\n*0* — No, así está bien`);
}

// El paso al que va `siguienteGastro` (sin preguntar nada): para pasarle un mensaje que ya contestaba eso.
function siguientePaso(ctx) {
  const d = ctx.datos;
  const forma = gastro.FORMAS[d.entrega];
  if (!forma) return 'eligiendo_entrega';
  if (forma.envio && !d.direccion) return 'pidiendo_direccion';
  if (forma.envio && !d.zona) return 'eligiendo_zona';
  if (!ctx.clienta.nombre) return 'pidiendo_nombre';
  if (!d.pago) return 'eligiendo_pago';
  return null;
}

// Lo de la entrega que va al pedido y al resumen: la forma, la zona elegida y lo que sale el envío.
function entregaDe(ctx) {
  const forma = gastro.FORMAS[ctx.datos.entrega] || gastro.FORMAS.RETIRO;
  const zona = forma.envio ? gastro.zonas(ctx.config).find((z) => z.nombre === ctx.datos.zona) || null : null;
  return { forma, zona, costo: gastro.costoEnvio(forma, zona) };
}

function pidiendo_nombre(ctx) {
  // "soy Bruno", "a nombre de Bruno", "me llamo Bruno", "Bruno!".
  const nombre = (ctx.msj.texto || '').trim()
    .replace(/^(?:hola[\s,!.]*)?(?:soy|me llamo|mi nombre es|a nombre de|de|para|ponele|pone|anotalo a nombre de|a)\s+/i, '')
    .replace(/[\s,.!]+$/, '').replace(/^\p{Ll}/u, (c) => c.toUpperCase());
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
  const zona = gastro.zonas(ctx.config).length > 1 ? ` (${ctx.datos.zona})` : '';
  const envio = forma.envio ? `\n🛵 Envío a ${ctx.datos.direccion}${zona} — ${precioEnvio(costo)}` : '';
  const donde = forma.envio ? '' : '\n📍 Lo retirás en el local.';
  const cuando = sale.programado
    ? `🕐 Ahora estamos cerrados: lo dejamos programado y está ${forma.envio ? 'llegando' : 'listo'} ${gastro.textoHora(sale.hora)}.`
    : `🕐 ${forma.envio ? 'Llega' : 'Está listo'} ${gastro.textoHora(sale.hora)} aprox.`;
  const pago = { alias: '\n💳 Pagás ahora por transferencia.', mp: '\n💳 Pagás ahora con Mercado Pago (te paso el link).' }[ctx.datos.pago] || '\n💵 Pagás al recibir.';
  return responder(ctx, 'confirmando_pedido',
    `${ctx.clienta.nombre}, así quedó tu pedido:\n\n${lineas}${envio}\n\n💰 Total: ${catalogo.plata(total)}${donde}\n${cuando}${pago}\n\n¿Te lo confirmo?\n*1* — Sí, confirmar\n*2* — Quiero agregar algo\n*0* — Cancelar`);
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
    ...(notaDe(items) ? { nota: notaDe(items) } : {}),
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
  return responder(ctx, 'inicio', `¡Listo, gracias! 🙌 Ya le pasé tu pedido a la cocina. En un ratito te confirmo por acá.${pagar}`);
}

const conNota = (r, nota) => { r[0].texto = `${nota}\n\n${r[0].texto}`; return r; };

function confirmando_pedido(ctx) {
  const norm = nlu.normalizar(ctx.texto);
  const cambia = /\b(?:no|cancel\w*|saca\w*|quita\w*|agreg\w*|suma\w*|cambi\w*|sin|falta\w*|olvide)\b/.test(norm);
  if (nlu.esSi(ctx.texto) || nlu.esCortesia(ctx.msj.texto || '')
    || (!cambia && /\b(?:si|dale|ok|perfecto|perfecta|joya|genial|confirm\w*|mandalo|pedilo|de una|esta bien|todo bien|barbaro|listo|correcto|asi)\b/.test(norm))) ctx.texto = '1';
  if (/^(?:agregar|agrego|sumar|quiero agregar|algo mas|me olvide)$/.test(norm)) ctx.texto = '2';
  if (/^(?:cancelar|cancela|cancelo|cancelalo|no quiero nada|dejalo)$/.test(norm)) ctx.texto = '0';
  if (ctx.texto === '2') return responder(ctx, 'armando_pedido', 'Dale, decime qué más querés.');
  if (ctx.texto === '0') { ctx.datos = {}; return responder(ctx, 'inicio', 'Listo, no anoté nada. Cuando quieras escribí *hola* 😊'); }
  if (ctx.texto !== '1') {
    // "sacame la coca", "sumale unas papas": se cambia el pedido y se vuelve a mostrar.
    const quitado = quitar(ctx, ctx.msj.texto || '') || aclararUltimo(ctx, ctx.msj.texto || '') || cambiarUltimo(ctx, ctx.msj.texto || '');
    if (quitado && !ctx.datos.items.length) return responder(ctx, 'armando_pedido', `${quitado} Decime qué querés, o *0* para cancelar.`);
    if (quitado) return conNota(resumen(ctx), quitado);
    const texto = (ctx.msj.texto || '').replace(/^(?:y\s+)?(?:sumale|sumame|suma|agregale|agregame|agrega|agregar|tambien|y)\s+/i, '');
    const leidas = separarLineas(texto).map((l) => leerLinea(ctx, l));
    if (leidas.length && leidas.every((r) => r.tipo === 'anotar')) return conNota(resumen(ctx), leidas.map((r) => sumar(ctx, r.producto, r).nota).join('\n'));
    // Algo para sumar que hay que elegir: se sigue armando y con *listo* vuelve el resumen.
    if (leidas.some((r) => ['anotar', 'elegir', 'pesar', 'parecidos'].includes(r.tipo))) return anotarVarias(ctx, separarLineas(texto), []);
    if (nlu.esNo(ctx.texto)) return responder(ctx, 'confirmando_pedido', '¿Qué querés cambiar? Podés decirme *sacame la coca* o *sumale unas papas*.\n\n*1* — Así está bien, confirmar\n*2* — Agregar algo\n*0* — Cancelar todo');
    return noEntendi(ctx, 'Respondé *1* para confirmar, *2* para agregar algo o *0* para cancelar.');
  }
  if (gastro.esGastro(ctx.config)) return confirmarGastro(ctx);
  qPedidos.crear(ctx.clienta.id, {
    cliente: { nombre: ctx.clienta.nombre, telefono: ctx.clienta.telefono },
    items: ctx.datos.items,
    ...(notaDe(ctx.datos.items) ? { nota: notaDe(ctx.datos.items) } : {}),
  });
  ctx.datos = {};
  return responder(ctx, 'inicio', '¡Listo! Le pasé tu pedido al local 🙌 Te aviso por acá apenas lo confirmen.');
}

// ---------- la IA, para lo que las reglas no entienden ----------
// Con la IA prendida (`config.ia`, ver src/ia.js), lo que el bot no entiende no se contesta todavía: sale un pedido de
// reescritura ({ ia: contexto }) y el motor (`procesarConIA`) vuelve a pasar el mensaje reescrito. En esa segunda pasada (o si la
// IA no pudo) no se vuelve a pedir: sigue como siempre. Nada se guardó todavía, así que la segunda pasada arranca igual.
function pedirIA(ctx) {
  if (!ctx.config.ia?.habilitada || ctx.msj.reescrito || ctx.msj.sinIA || !(ctx.msj.texto || '').trim()) return null;
  return [{ para: ctx.clienta.telefono, ia: contextoIA(ctx) }];
}

const PASOS = {
  inicio: 'Charla libre: puede pedir productos o hacer una pregunta.',
  consultando: 'Charla libre: está mirando precios; puede pedir productos o hacer una pregunta.',
  armando_pedido: 'Está armando el pedido: puede sumar productos, sacar algo, aclarar algo para la cocina o decir "listo" si terminó.',
  eligiendo_producto: 'El bot le preguntó cuál de estas opciones quiere.',
  eligiendo_peso: 'El bot le preguntó cuánto quiere (en gramos o kilos).',
  ofreciendo_extras: 'El bot le ofreció sumar algo al pedido.',
  eligiendo_entrega: 'El bot le preguntó cómo lo quiere recibir.',
  pidiendo_direccion: 'El bot le pidió la dirección de entrega.',
  eligiendo_zona: 'El bot le preguntó en qué zona está.',
  pidiendo_nombre: 'El bot le pidió un nombre para el pedido.',
  eligiendo_pago: 'El bot le preguntó cómo paga.',
  confirmando_pedido: 'El bot le mostró el resumen del pedido y le preguntó si lo confirma.',
};

function contextoIA(ctx) {
  const c = ctx.config;
  const d = ctx.datos;
  const estado = ctx.clienta.estado_conv || 'inicio';
  const nombres = (gids) => (gids || []).map((g) => catalogo.porGid(g)).filter(Boolean).map(nombreConPrecio);
  const opciones = {
    eligiendo_producto: nombres(d.opciones),
    ofreciendo_extras: [...nombres(d.extras), ...((d.extras || []).length > 1 ? ['Las dos'] : [])],
    eligiendo_entrega: gastro.formas(c).map((f) => f.texto),
    eligiendo_zona: gastro.zonas(c).map((z) => z.nombre),
    eligiendo_pago: gastro.pagos(c).map((p) => gastro.TEXTO_PAGO[p]),
    confirmando_pedido: ['Sí, confirmar', 'Quiero agregar algo'],
  }[estado] || [];
  return {
    negocio: `${c.negocio.nombre} (${c.textos.emoji})`,
    paso: PASOS[estado] || PASOS.inicio,
    ...(opciones.length ? { opciones: opciones.map((o, i) => `${i + 1}. ${o}`) } : {}),
    ...((d.items || []).length ? { pedido: d.items.map(cuantoDe) } : {}),
    // Con el precio, para "la más barata" o "la de 10 lucas".
    carta: catalogo.todos().filter((x) => x.hay).slice(0, 150).map((x) => ({ nombre: x.nombre, precio: catalogo.plata(x.precioCentavos) })),
    mensaje: (ctx.msj.texto || '').slice(0, 500),
  };
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
    r[0].texto = `${r[0].texto.replace('\nCuando quieras armar el pedido, escribime *pedido*.', '')}\n\n${ayuda}`;
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
