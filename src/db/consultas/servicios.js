// Consultas de servicios. La DB es la fuente de verdad de precios.
const { obtener } = require('../index');

function activos() {
  return obtener().prepare('SELECT * FROM servicios WHERE activo = 1 ORDER BY id').all();
}

function porId(id) {
  return obtener().prepare('SELECT * FROM servicios WHERE id = ?').get(id);
}

function porCatalogoId(catalogoId) {
  if (!catalogoId) return null;
  return obtener().prepare(
    'SELECT * FROM servicios WHERE catalogo_id = ? AND activo = 1'
  ).get(String(catalogoId));
}

function cambiarPrecio(id, precio) {
  obtener().prepare('UPDATE servicios SET precio = ? WHERE id = ?').run(precio, id);
}

module.exports = { activos, porId, porCatalogoId, cambiarPrecio };
