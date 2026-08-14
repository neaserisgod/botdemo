// Consultas de turnos. Estados que ocupan agenda: pendiente_sena y confirmado.
const { obtener } = require('../index');

const OCUPAN = "('pendiente_sena','confirmado')";

function crear(clientaId, servicioId, inicio, fin, estado) {
  const r = obtener().prepare(`
    INSERT INTO turnos (clienta_id, servicio_id, inicio, fin, estado)
    VALUES (?, ?, ?, ?, ?)
  `).run(clientaId, servicioId, inicio, fin, estado);
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

function cambiarEstado(id, estado) {
  obtener().prepare('UPDATE turnos SET estado = ? WHERE id = ?').run(estado, id);
}

// ¿Hay solapamiento? Dos rangos se pisan si (inicioA < finB) y (finA > inicioB).
function haySolapamiento(inicio, fin) {
  const fila = obtener().prepare(`
    SELECT COUNT(*) AS n FROM turnos
    WHERE estado IN ${OCUPAN} AND inicio < ? AND fin > ?
  `).get(fin, inicio);
  return fila.n > 0;
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
  crear, porId, cambiarEstado, haySolapamiento, ocupadosDelDia, delDia,
  entreFechas, proximoDeClienta, pendientesDeRecordatorio,
  marcarRecordatorioEnviado, guardarRespuestaRecordatorio,
};
