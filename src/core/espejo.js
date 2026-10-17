// El catálogo de WhatsApp Business igual a la carta de Nodo Sur (Nodo Gastro, El dueño, 2026-10-16: "¿me pasás el catálogo?
// ¡Pum! link al catálogo… agrega el carrito, envía el carrito"). La carta la maneja la app: el bot solo la copia, así el local no
// carga los platos dos veces. Se prende con `negocio.catalogo_whatsapp` (un local sin WhatsApp Business no tiene catálogo).
//
// Acá vive solo la cuenta de qué hay que hacer (crear, cambiar, esconder, borrar); el adaptador de Baileys lo hace
// (`espejarCatalogo`). Reglas:
//  * Solo se tocan los productos que puso el bot: llevan como "ID de contenido" (retailer id) `ns-<global_id>`. Lo que el local
//    cargó a mano en WhatsApp queda como está.
//  * Lo que hoy no hay se esconde (no se borra): mañana vuelve con el mismo producto. Lo que se borró de la carta, se borra.
//  * Lo que se vende por peso no va: el catálogo de WhatsApp solo pide unidades.
//  * El precio en WhatsApp va en milésimas de la moneda (el `priceAmount1000` de WhatsApp): centavos × 10.
//  * Pocas operaciones por vuelta (`max`): muchas seguidas se parecen a un robot y WhatsApp puede bloquear el número. Lo que
//    falta sale en la vuelta siguiente.
const catalogo = require('./catalogo');

const PREFIJO = 'ns-';
const retailerDe = (gid) => `${PREFIJO}${gid}`;
const gidDeRetailer = (r) => (typeof r === 'string' && r.startsWith(PREFIJO) ? r.slice(PREFIJO.length) : null);
const precioWa = (centavos) => centavos * 10;
const MAX_NOMBRE = 120;

// `items`: la carta (`catalogo.todos()`); `actuales`: lo que devuelve getCatalog. → { crear, cambiar, borrar } en ese orden.
function planEspejo({ items, actuales, max = 20 }) {
  const nuestros = new Map();
  for (const p of actuales || []) {
    const gid = gidDeRetailer(p.retailerId);
    if (gid && p.id) nuestros.set(gid, p);
  }
  const crear = [];
  const cambiar = [];
  const enLaCarta = new Set();
  for (const x of items || []) {
    if (!x.gid || catalogo.esPesable(x) || !Number.isSafeInteger(x.precioCentavos) || x.precioCentavos <= 0) continue;
    enLaCarta.add(x.gid);
    const quiero = { name: String(x.nombre).slice(0, MAX_NOMBRE), price: precioWa(x.precioCentavos), isHidden: !x.hay };
    const ya = nuestros.get(x.gid);
    if (!ya) {
      if (x.hay) crear.push({ retailerId: retailerDe(x.gid), ...quiero });
    } else if (ya.name !== quiero.name || Number(ya.price) !== quiero.price || !!ya.isHidden !== quiero.isHidden) {
      cambiar.push({ id: ya.id, retailerId: retailerDe(x.gid), ...quiero });
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

module.exports = { planEspejo, retailerDe, gidDeRetailer, precioWa, PREFIJO };
