// Consultas de señas. nro_operacion UNIQUE es la defensa contra duplicados.
const { obtener } = require('../index');

function crear(turnoId, montoEsperado, venceEn) {
  const r = obtener().prepare(`
    INSERT INTO senas (turno_id, monto_esperado, vence_en) VALUES (?, ?, ?)
  `).run(turnoId, montoEsperado, venceEn);
  return r.lastInsertRowid;
}

function porId(id) {
  return obtener().prepare('SELECT * FROM senas WHERE id = ?').get(id);
}

function porTurno(turnoId) {
  return obtener().prepare(
    'SELECT * FROM senas WHERE turno_id = ? ORDER BY id DESC LIMIT 1'
  ).get(turnoId);
}

function existeOperacion(nroOperacion) {
  if (!nroOperacion) return false;
  return !!obtener().prepare('SELECT id FROM senas WHERE nro_operacion = ?').get(nroOperacion);
}

function resolver(id, { estado, monto, destinatario, nroOperacion, fecha, rutaImagen, ocrTexto, motivo, por }) {
  obtener().prepare(`
    UPDATE senas SET estado = @estado, monto_detectado = @monto,
      destinatario_detectado = @destinatario, nro_operacion = @nroOperacion,
      fecha_detectada = @fecha, ruta_imagen = @rutaImagen, ocr_texto = @ocrTexto,
      motivo_revision = @motivo,
      resuelta_en = datetime('now', 'localtime'), resuelta_por = @por
    WHERE id = @id
  `).run({ id, estado, monto: monto ?? null, destinatario: destinatario ?? null,
           nroOperacion: nroOperacion ?? null, fecha: fecha ?? null,
           rutaImagen: rutaImagen ?? null, ocrTexto: ocrTexto ?? null,
           motivo: motivo ?? null, por });
}

function cambiarEstado(id, estado, por) {
  obtener().prepare(`
    UPDATE senas SET estado = ?, resuelta_en = datetime('now', 'localtime'), resuelta_por = ?
    WHERE id = ?
  `).run(estado, por || null, id);
}

// Señas vencidas: esperando comprobante y pasadas de fecha.
function vencidas(ahoraTexto) {
  return obtener().prepare(`
    SELECT * FROM senas WHERE estado = 'esperando_comprobante' AND vence_en <= ?
  `).all(ahoraTexto);
}

module.exports = { crear, porId, porTurno, existeOperacion, resolver, cambiarEstado, vencidas };
