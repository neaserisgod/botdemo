// Conexión SQLite + siembra de servicios desde config.json.
// La DB de la demo va en data/turnos.db (nunca toca la DB de Nefertiti).
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

let db = null;

function abrir(rutaDb) {
  const ruta = rutaDb || path.join(__dirname, '..', '..', 'data', 'turnos.db');
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  db = new Database(ruta);
  const esquema = fs.readFileSync(path.join(__dirname, 'esquema.sql'), 'utf8');
  db.exec(esquema);
  return db;
}

// config.json es la semilla; en runtime la fuente de verdad de precios es la DB.
function sembrarServicios(servicios) {
  const up = db.prepare(`
    INSERT INTO servicios (id, nombre, duracion_min, precio, sena, catalogo_id, activo)
    VALUES (@id, @nombre, @duracion_min, @precio, @sena, @catalogo_id, 1)
    ON CONFLICT(id) DO UPDATE SET
      nombre = excluded.nombre, duracion_min = excluded.duracion_min,
      precio = excluded.precio, sena = excluded.sena, catalogo_id = excluded.catalogo_id
  `);
  const tx = db.transaction((lista) => lista.forEach((s) => up.run(s)));
  tx(servicios);
}

function obtener() {
  if (!db) throw new Error('DB no inicializada: llamá abrir() primero');
  return db;
}

module.exports = { abrir, sembrarServicios, obtener };
