// El catálogo de WhatsApp Business igual a la carta de Nodo Sur (Nodo Gastro, El dueño, 2026-10-16: "¿me pasás el catálogo?
// ¡Pum! link al catálogo… agrega el carrito, envía el carrito"). La carta la maneja la app: el bot solo la copia, así el local no
// carga los platos dos veces. Se prende con `negocio.catalogo_whatsapp` (un local sin WhatsApp Business no tiene catálogo).
//
// Acá vive solo la cuenta de qué hay que hacer (crear, cambiar, esconder, borrar); el adaptador de Baileys lo hace
// (`espejarCatalogo`). Reglas:
//  * Solo se tocan los productos que puso el bot: llevan como "ID de contenido" (retailer id) `ns-<global_id>`. Lo que el local
//    cargó a mano en WhatsApp queda como está, salvo que se llame igual que un plato de la carta: ese se ADOPTA (pasa a ser el
//    del plato, con el precio de la app) en vez de crear otro igual. Pasa sobre todo después de traer el catálogo de WhatsApp a
//    la app (`catalogoParaLaApp`): los platos que se crearon de ahí se adoptan solos.
//  * Lo que hoy no hay se esconde (no se borra): mañana vuelve con el mismo producto. Lo que se borró de la carta, se borra.
//  * Lo que se vende por peso no va: el catálogo de WhatsApp solo pide unidades.
//  * La foto: la que se sacó en la app (`foto` del plato, la versión) o una genérica. Solo se manda cuando hay que ponerla o
//    cambiarla (`foto` en el plan: la versión, o null para la genérica); si no, la que tenga en WhatsApp queda como está, igual
//    que la descripción, que el bot nunca escribe. `fotos` es lo que ya quedó puesto (`nube/fotos.js`).
//  * El precio en WhatsApp va en milésimas de la moneda (el `priceAmount1000` de WhatsApp): centavos × 10.
//  * Pocas operaciones por vuelta (`max`): muchas seguidas se parecen a un robot y WhatsApp puede bloquear el número. Lo que
//    falta sale en la vuelta siguiente.
const catalogo = require('./catalogo');

const PREFIJO = 'ns-';
const retailerDe = (gid) => `${PREFIJO}${gid}`;
const gidDeRetailer = (r) => (typeof r === 'string' && r.startsWith(PREFIJO) ? r.slice(PREFIJO.length) : null);
const precioWa = (centavos) => centavos * 10;
const MAX_NOMBRE = 120;
const normal = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

// `items`: la carta (`catalogo.todos()`); `actuales`: lo que devuelve getCatalog; `fotos`: gid → versión puesta (null = la
// genérica). → { crear, cambiar, borrar } en ese orden.
function planEspejo({ items, actuales, max = 20, fotos = new Map() }) {
  const nuestros = new Map();
  for (const p of actuales || []) {
    const gid = gidDeRetailer(p.retailerId);
    if (gid && p.id) nuestros.set(gid, p);
  }
  // Los cargados a mano (sin `ns-`), por nombre, para adoptarlos.
  const aMano = new Map();
  for (const p of actuales || []) {
    if (!gidDeRetailer(p.retailerId) && p.id && !aMano.has(normal(p.name))) aMano.set(normal(p.name), p);
  }
  const crear = [];
  const cambiar = [];
  const enLaCarta = new Set();
  for (const x of items || []) {
    if (!x.gid || catalogo.esPesable(x) || !Number.isSafeInteger(x.precioCentavos) || x.precioCentavos <= 0) continue;
    enLaCarta.add(x.gid);
    const quiero = { gid: x.gid, name: String(x.nombre).slice(0, MAX_NOMBRE), price: precioWa(x.precioCentavos), isHidden: !x.hay };
    const foto = x.foto || null;
    const ya = nuestros.get(x.gid);
    const adoptar = !ya && aMano.get(normal(x.nombre));
    if (adoptar) {
      // Lo cargado a mano tiene su foto: se cambia solo si en la app se sacó una.
      aMano.delete(normal(x.nombre));
      cambiar.push({ id: adoptar.id, retailerId: retailerDe(x.gid), ...quiero, adoptado: true, ...(foto ? { foto } : {}) });
    } else if (!ya) {
      if (x.hay) crear.push({ retailerId: retailerDe(x.gid), ...quiero, foto });
    } else {
      // Un plato de antes de las fotos no tiene nada anotado: cuenta como la genérica.
      const cambiaFoto = (fotos.get(x.gid) ?? null) !== foto;
      if (cambiaFoto || ya.name !== quiero.name || Number(ya.price) !== quiero.price || !!ya.isHidden !== quiero.isHidden) {
        cambiar.push({ id: ya.id, retailerId: retailerDe(x.gid), ...quiero, ...(cambiaFoto ? { foto } : {}) });
      }
    }
  }
  const borrar = [...nuestros.entries()].filter(([gid]) => !enLaCarta.has(gid)).map(([, p]) => p.id);
  // Primero lo que la gente ve mal (precio o "no hay"), después lo nuevo, y lo borrado al final.
  let resto = max;
  const tomar = (lista) => { const r = lista.slice(0, Math.max(resto, 0)); resto -= r.length; return r; };
  const c = tomar(cambiar);
  const n = tomar(crear);
  const b = resto > 0 ? borrar.slice(0, resto) : [];
  const pendientes = cambiar.length - c.length + crear.length - n.length + borrar.length - b.length;
  return { cambiar: c, crear: n, borrar: b, pendientes };
}

// Lo que la app necesita para traer el catálogo de WhatsApp a su carta (`POST /api/bot/catalogo-wa`): de cada producto, su id,
// su "ID de contenido", nombre, descripción, precio en centavos y si está escondido.
function catalogoParaLaApp(productos) {
  return (productos || []).filter((p) => p && p.id && p.name).map((p) => ({
    waId: String(p.id),
    retailerId: p.retailerId || null,
    nombre: String(p.name).trim().slice(0, 120),
    descripcion: String(p.description || '').trim().slice(0, 500),
    precioCentavos: Math.max(0, Math.round((Number(p.price) || 0) / 10)),
    oculto: !!p.isHidden,
  })).filter((x) => /^[\w-]{1,64}$/.test(x.waId) && x.nombre);
}

module.exports = { planEspejo, catalogoParaLaApp, retailerDe, gidDeRetailer, precioWa, PREFIJO };
