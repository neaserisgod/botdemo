// Consultas de clientas: alta implícita al primer mensaje + estado conversacional.
const { obtener } = require('../index');

function porTelefono(telefono) {
  return obtener().prepare('SELECT * FROM clientas WHERE telefono = ?').get(telefono);
}

function obtenerOCrear(telefono) {
  const db = obtener();
  let c = porTelefono(telefono);
  if (!c) {
    db.prepare('INSERT INTO clientas (telefono) VALUES (?)').run(telefono);
    c = porTelefono(telefono);
  }
  return c;
}

function guardarEstado(id, estado, datos) {
  obtener().prepare(`
    UPDATE clientas SET estado_conv = ?, datos_conv = ?,
      ultima_interaccion = datetime('now', 'localtime')
    WHERE id = ?
  `).run(estado, JSON.stringify(datos || {}), id);
}

function guardarNombre(id, nombre) {
  obtener().prepare('UPDATE clientas SET nombre = ? WHERE id = ?').run(nombre, id);
}

function sumarNoEntendido(id) {
  obtener().prepare('UPDATE clientas SET no_entendidos = no_entendidos + 1 WHERE id = ?').run(id);
  return obtener().prepare('SELECT no_entendidos FROM clientas WHERE id = ?').get(id).no_entendidos;
}

function limpiarNoEntendidos(id) {
  obtener().prepare('UPDATE clientas SET no_entendidos = 0 WHERE id = ?').run(id);
}

// Derivada a humano: el bot no contesta hasta esta fecha (la dueña atiende a mano).
function derivar(id, horas) {
  obtener().prepare(`
    UPDATE clientas SET derivada_hasta = datetime('now', 'localtime', '+' || ? || ' hours'),
      no_entendidos = 0, estado_conv = 'inicio', datos_conv = '{}'
    WHERE id = ?
  `).run(horas, id);
}

function estaDerivada(c) {
  if (!c.derivada_hasta) return false;
  return c.derivada_hasta > new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function todas() {
  return obtener().prepare('SELECT * FROM clientas ORDER BY id').all();
}

module.exports = {
  porTelefono, obtenerOCrear, guardarEstado, guardarNombre,
  sumarNoEntendido, limpiarNoEntendidos, derivar, estaDerivada, todas,
};
