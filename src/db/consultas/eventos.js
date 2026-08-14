// Registro de eventos de conectividad y salud.
const { obtener } = require('../index');

function registrar(tipo, detalle) {
  obtener().prepare(
    'INSERT INTO eventos_conectividad (tipo, detalle) VALUES (?, ?)'
  ).run(tipo, detalle || null);
}

function ultimos(n) {
  return obtener().prepare(
    'SELECT * FROM eventos_conectividad ORDER BY id DESC LIMIT ?'
  ).all(n || 20);
}

function ultimoDeTipo(tipo) {
  return obtener().prepare(
    'SELECT * FROM eventos_conectividad WHERE tipo = ? ORDER BY id DESC LIMIT 1'
  ).get(tipo);
}

module.exports = { registrar, ultimos, ultimoDeTipo };
