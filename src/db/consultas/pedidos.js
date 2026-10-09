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

// Solo desde 'enviado': un pedido ya resuelto no cambia (si el aviso llega dos veces, no se le avisa dos veces al cliente).
function resolver(id, estado) {
  const r = obtener().prepare("UPDATE pedidos SET estado = ?, actualizado_en = datetime('now', 'localtime') WHERE id = ? AND estado = 'enviado'")
    .run(estado, id);
  return r.changes > 0;
}

function marcarAvisado(id) {
  obtener().prepare('UPDATE pedidos SET avisado = 1 WHERE id = ?').run(id);
}

// Resueltos que el cliente todavía no sabe (el aviso pudo fallar por falta de conexión con WhatsApp).
function sinAvisar() {
  return obtener().prepare("SELECT * FROM pedidos WHERE estado IN ('aceptado', 'rechazado') AND avisado = 0 ORDER BY id").all().map(leer);
}

module.exports = { crear, porId, porEnviar, marcarEnviado, porRemotoId, resolver, marcarAvisado, sinAvisar };
