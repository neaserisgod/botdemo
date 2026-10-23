// Pedidos de un comercio: la bandeja de salida hacia Nodo Sur (ver el comentario de la tabla en esquema.sql).
const crypto = require('crypto');
const { obtener } = require('../index');

const leer = (f) => (f ? { ...f, datos: JSON.parse(f.datos) } : null);

// El pedido_id lo inventa el bot: es lo que hace que reintentar el envío no lo duplique en Nodo Sur.
function crear(clientaId, datos) {
  const pedidoId = `wa-${crypto.randomBytes(9).toString('base64url')}`;
  const r = obtener().prepare('INSERT INTO pedidos (pedido_id, clienta_id, datos) VALUES (?, ?, ?)')
    .run(pedidoId, clientaId, JSON.stringify(datos));
  return porId(Number(r.lastInsertRowid));
}

function porId(id) {
  return leer(obtener().prepare('SELECT * FROM pedidos WHERE id = ?').get(id));
}

function porEnviar() {
  return obtener().prepare("SELECT * FROM pedidos WHERE estado = 'por_enviar' ORDER BY id").all().map(leer);
}

function marcarEnviado(id, remotoId) {
  obtener().prepare("UPDATE pedidos SET estado = 'enviado', remoto_id = ?, actualizado_en = datetime('now', 'localtime') WHERE id = ? AND estado = 'por_enviar'")
    .run(remotoId, id);
}

function porRemotoId(remotoId) {
  return leer(obtener().prepare('SELECT * FROM pedidos WHERE remoto_id = ?').get(remotoId));
}

// Lo que el local hace con un pedido en la app, y desde qué estado se llega a cada cosa: siempre para adelante, así un aviso
// que llega dos veces (o tarde) no se le manda dos veces al cliente. Un almacén solo acepta o rechaza; un local gastronómico
// además lo pone listo, lo manda, lo entrega o lo cancela (los mismos pasos que el sitio, `PASOS_PEDIDO` en NodoSurPage). Si
// el bot no vio un paso (estuvo apagado), salta al que ve.
// `pagado`: se acreditó el link de Mercado Pago y el pedido le llegó al local (en el sitio pasa a "por confirmar").
const DESDE = {
  pagado: ['enviado'],
  aceptado: ['enviado', 'pagado'],
  rechazado: ['enviado', 'pagado'],
  listo: ['enviado', 'pagado', 'aceptado'],
  en_camino: ['enviado', 'pagado', 'aceptado', 'listo'],
  entregado: ['enviado', 'pagado', 'aceptado', 'listo', 'en_camino'],
  cancelado: ['enviado', 'pagado', 'aceptado', 'listo'],
};
const ESTADOS_RESUELTOS = Object.keys(DESDE);

function resolver(id, estado) {
  const desde = DESDE[estado];
  if (!desde) return false;
  const r = obtener().prepare(`UPDATE pedidos SET estado = ?, avisado = 0, actualizado_en = datetime('now', 'localtime') WHERE id = ? AND estado IN (${desde.map(() => '?').join(', ')})`)
    .run(estado, id, ...desde);
  return r.changes > 0;
}

// Nodo Sur no lo pudo recibir (lleva gramos y el sitio todavía no los acepta): se le mandó al local por WhatsApp y lo
// sigue a mano. No se reintenta ni se le avisa al cliente desde acá.
function marcarAMano(id) {
  obtener().prepare("UPDATE pedidos SET estado = 'a_mano', actualizado_en = datetime('now', 'localtime') WHERE id = ? AND estado = 'por_enviar'").run(id);
}

// El sitio no pudo armar el link de Mercado Pago y el pedido entró para pagar al recibir: así queda también acá (si no, volver a
// "por confirmar" se leería como "pagó").
function pagaAlRecibir(id) {
  const p = porId(id);
  if (!p) return;
  obtener().prepare('UPDATE pedidos SET datos = ? WHERE id = ?').run(JSON.stringify({ ...p.datos, pago: 'al_entregar' }), id);
}

function marcarAvisado(id) {
  obtener().prepare('UPDATE pedidos SET avisado = 1 WHERE id = ?').run(id);
}

// Resueltos que el cliente todavía no sabe (el aviso pudo fallar por falta de conexión con WhatsApp).
function sinAvisar() {
  return obtener().prepare(`SELECT * FROM pedidos WHERE estado IN (${ESTADOS_RESUELTOS.map(() => '?').join(', ')}) AND avisado = 0 ORDER BY id`)
    .all(...ESTADOS_RESUELTOS).map(leer);
}

// El último pedido de un cliente (para "¿ya está mi pedido?", "lo mismo que la otra vez" y el comprobante de la transferencia).
function ultimoDe(clientaId) {
  return leer(obtener().prepare('SELECT * FROM pedidos WHERE clienta_id = ? ORDER BY id DESC LIMIT 1').get(clientaId));
}

module.exports = { ESTADOS_RESUELTOS, crear, porId, ultimoDe, porEnviar, marcarEnviado, marcarAMano, porRemotoId, resolver, marcarAvisado, sinAvisar, pagaAlRecibir };
