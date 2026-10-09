// Lo que el bot no entendió, para mejorar el diccionario (ver la tabla en esquema.sql).
const { obtener } = require('../index');

const GUARDAR = 500;

function registrar(telefono, texto, estado) {
  const t = String(texto || '').trim().slice(0, 300);
  if (!t) return;
  const db = obtener();
  db.prepare('INSERT INTO no_entendidos (telefono, texto, estado) VALUES (?, ?, ?)').run(telefono, t, estado || null);
  db.prepare('DELETE FROM no_entendidos WHERE id <= (SELECT MAX(id) FROM no_entendidos) - ?').run(GUARDAR);
}

// Los más recientes, sin repetir (el mismo texto dicho varias veces cuenta una vez, con cuántas fueron).
function ultimos(cuantos = 15) {
  return obtener().prepare(`
    SELECT LOWER(texto) AS clave, MAX(texto) AS texto, COUNT(*) AS veces, MAX(creado_en) AS ultimo
    FROM no_entendidos GROUP BY LOWER(texto) ORDER BY MAX(id) DESC LIMIT ?
  `).all(cuantos);
}

module.exports = { registrar, ultimos };
