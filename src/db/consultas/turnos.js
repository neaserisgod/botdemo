// Consultas de turnos. Estados que ocupan agenda: pendiente_sena y confirmado.
//
// Con Nodo Sur (negocios de servicios vinculados, 2026-10-10): cada turno lleva el id con que viaja (`nube_id`) y queda
// "pendiente" cuando cambia acá, para que `nube/sincronizar.js` lo reserve o avise el cambio. Lo que llega DE Nodo Sur (la
// dueña lo movió o lo canceló en la app) se escribe con `{ desdeNube: true }`, que no lo vuelve a marcar: si no, iría y
// volvería para siempre.
const crypto = require('crypto');
const { obtener } = require('../index');

const OCUPAN = "('pendiente_sena','confirmado')";
const OCUPAN_NUBE = "('esperando_sena','confirmado','atendido')";

function crear(clientaId, servicioId, inicio, fin, estado) {
  const r = obtener().prepare(`
    INSERT INTO turnos (clienta_id, servicio_id, inicio, fin, estado, nube_id, nube_pendiente)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(clientaId, servicioId, inicio, fin, estado, `turno-${crypto.randomBytes(12).toString('hex')}`);
  return r.lastInsertRowid;
}

function porId(id) {
  return obtener().prepare(`
    SELECT t.*, s.nombre AS servicio, s.precio, s.sena AS sena_monto,
           c.telefono, c.nombre AS clienta_nombre
    FROM turnos t
    JOIN servicios s ON s.id = t.servicio_id
    JOIN clientas c ON c.id = t.clienta_id
    WHERE t.id = ?
  `).get(id);
}

function cambiarEstado(id, estado, { desdeNube = false } = {}) {
  obtener().prepare(`UPDATE turnos SET estado = ?${desdeNube ? '' : ', nube_pendiente = 1'} WHERE id = ?`).run(estado, id);
}

// ¿Hay solapamiento? Dos rangos se pisan si (inicioA < finB) y (finA > inicioB). `excluirId`: el turno que se está
// cambiando de horario no se pisa consigo mismo (pasarlo media hora más tarde tiene que poder).
// También mira lo que ocupa la agenda de la app de Nodo Sur (`turnos_nube`): el bot nunca ofrece un horario que dio la dueña.
function haySolapamiento(inicio, fin, excluirId = 0) {
  const fila = obtener().prepare(`
    SELECT (SELECT COUNT(*) FROM turnos WHERE estado IN ${OCUPAN} AND inicio < ? AND fin > ? AND id != ?)
         + (SELECT COUNT(*) FROM turnos_nube WHERE estado IN ${OCUPAN_NUBE} AND inicio < ? AND fin > ?) AS n
  `).get(fin, inicio, excluirId || 0, fin, inicio);
  return fila.n > 0;
}

// El cliente cambió el turno de día u hora: es el mismo turno (con su seña, si la tenía), en otro horario. El
// recordatorio se vuelve a mandar para el horario nuevo.
function mover(id, inicio, fin, { desdeNube = false } = {}) {
  obtener().prepare(`
    UPDATE turnos SET inicio = ?, fin = ?, recordatorio_enviado = 0, recordatorio_respuesta = NULL${desdeNube ? '' : ', nube_pendiente = 1'} WHERE id = ?
  `).run(inicio, fin, id);
}

// --- Nodo Sur ----------------------------------------------------------------------------------------------------------

// Los turnos con algo para mandar (reservarlo, o avisar un cambio), los más viejos primero.
function paraNube() {
  return obtener().prepare(`
    SELECT t.*, s.nombre AS servicio, s.catalogo_id, s.sena AS sena_monto, c.telefono, c.nombre AS clienta_nombre
    FROM turnos t JOIN servicios s ON s.id = t.servicio_id JOIN clientas c ON c.id = t.clienta_id
    WHERE t.nube_pendiente = 1 ORDER BY t.id
  `).all();
}

function marcarEnNube(id, { enviado }) {
  obtener().prepare(`UPDATE turnos SET nube_pendiente = 0${enviado ? ', nube_enviado = 1' : ''} WHERE id = ?`).run(id);
}

function porNubeId(nubeId) {
  return obtener().prepare(`
    SELECT t.*, s.nombre AS servicio, c.telefono, c.nombre AS clienta_nombre
    FROM turnos t JOIN servicios s ON s.id = t.servicio_id JOIN clientas c ON c.id = t.clienta_id
    WHERE t.nube_id = ?
  `).get(nubeId);
}

// Lo que ocupa la agenda de la app (sin datos de clientes).
function guardarOcupadoNube(turnoId, inicio, fin, estado) {
  obtener().prepare(`
    INSERT INTO turnos_nube (turno_id, inicio, fin, estado) VALUES (?, ?, ?, ?)
    ON CONFLICT(turno_id) DO UPDATE SET inicio = excluded.inicio, fin = excluded.fin, estado = excluded.estado
  `).run(turnoId, inicio, fin, estado);
}

function ocupadosDelDia(fechaYmd) {
  return obtener().prepare(`
    SELECT inicio, fin FROM turnos
    WHERE estado IN ${OCUPAN} AND inicio LIKE ? || '%'
    ORDER BY inicio
  `).all(fechaYmd);
}

function delDia(fechaYmd) {
  return obtener().prepare(`
    SELECT t.*, s.nombre AS servicio, s.precio, c.nombre AS clienta_nombre, c.telefono
    FROM turnos t
    JOIN servicios s ON s.id = t.servicio_id
    JOIN clientas c ON c.id = t.clienta_id
    WHERE t.inicio LIKE ? || '%' AND t.estado IN ${OCUPAN}
    ORDER BY t.inicio
  `).all(fechaYmd);
}

function entreFechas(desde, hasta) {
  return obtener().prepare(`
    SELECT t.*, s.nombre AS servicio, c.nombre AS clienta_nombre, c.telefono
    FROM turnos t
    JOIN servicios s ON s.id = t.servicio_id
    JOIN clientas c ON c.id = t.clienta_id
    WHERE t.inicio >= ? AND t.inicio < ? AND t.estado IN ${OCUPAN}
    ORDER BY t.inicio
  `).all(desde, hasta);
}

// Cuántos turnos tuvo (para saber si es clienta nueva y mandarle el contacto
// a la dueña una sola vez).
function contarDeClienta(clientaId) {
  return obtener().prepare(
    `SELECT COUNT(*) AS n FROM turnos WHERE clienta_id = ? AND estado IN ${OCUPAN}`
  ).get(clientaId).n;
}

function proximoDeClienta(clientaId, desdeFecha) {
  return obtener().prepare(`
    SELECT t.*, s.nombre AS servicio FROM turnos t
    JOIN servicios s ON s.id = t.servicio_id
    WHERE t.clienta_id = ? AND t.estado IN ${OCUPAN} AND t.inicio > ?
    ORDER BY t.inicio LIMIT 1
  `).get(clientaId, desdeFecha);
}

// Recordatorios: confirmados que arrancan dentro de la ventana y sin recordatorio
// enviado. El catch-up al reiniciar usa esta misma consulta: agarra también los
// que quedaron pendientes mientras el bot estaba caído (inicio todavía futuro).
function pendientesDeRecordatorio(desde, hasta) {
  return obtener().prepare(`
    SELECT t.*, s.nombre AS servicio, c.telefono, c.nombre AS clienta_nombre
    FROM turnos t
    JOIN servicios s ON s.id = t.servicio_id
    JOIN clientas c ON c.id = t.clienta_id
    WHERE t.estado = 'confirmado' AND t.recordatorio_enviado = 0
      AND t.inicio > ? AND t.inicio <= ?
    ORDER BY t.inicio
  `).all(desde, hasta);
}

function marcarRecordatorioEnviado(id) {
  obtener().prepare('UPDATE turnos SET recordatorio_enviado = 1 WHERE id = ?').run(id);
}

function guardarRespuestaRecordatorio(id, respuesta) {
  obtener().prepare('UPDATE turnos SET recordatorio_respuesta = ? WHERE id = ?').run(respuesta, id);
}

module.exports = {
  crear, porId, cambiarEstado, haySolapamiento, mover, ocupadosDelDia, delDia,
  entreFechas, proximoDeClienta, contarDeClienta, pendientesDeRecordatorio,
  marcarRecordatorioEnviado, guardarRespuestaRecordatorio,
  paraNube, marcarEnNube, porNubeId, guardarOcupadoNube,
};
