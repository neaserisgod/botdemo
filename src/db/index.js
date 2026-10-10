// Conexión SQLite + siembra de servicios desde config.json.
// La DB de la demo va en data/turnos.db (nunca toca la DB de Nefertiti).
const fs = require('fs');
const path = require('path');
const { abrirBase } = require('./motor');

let db = null;

function abrir(rutaDb) {
  const ruta = rutaDb || path.join(__dirname, '..', '..', 'data', 'turnos.db');
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  db = abrirBase(ruta);
  if (process.env.DEPURAR) console.log(`SQLite: ${db.motor}`);
  const esquema = fs.readFileSync(path.join(__dirname, 'esquema.sql'), 'utf8');
  db.exec(esquema);
  migrar(db);
  return db;
}

// CREATE TABLE IF NOT EXISTS no agrega columnas a una base que ya existe (la de
// un celu instalado antes): cada columna nueva se suma acá, una sola vez.
function migrar(base) {
  const columnas = base.prepare('PRAGMA table_info(servicios)').all().map((c) => c.name);
  if (!columnas.includes('alias')) {
    base.exec("ALTER TABLE servicios ADD COLUMN alias TEXT NOT NULL DEFAULT ''");
  }
  // Turnos con Nodo Sur (2026-10-10): el id con que viaja cada turno y si tiene un cambio sin mandar.
  const deTurnos = base.prepare('PRAGMA table_info(turnos)').all().map((c) => c.name);
  if (!deTurnos.includes('nube_id')) base.exec('ALTER TABLE turnos ADD COLUMN nube_id TEXT');
  if (!deTurnos.includes('nube_pendiente')) base.exec('ALTER TABLE turnos ADD COLUMN nube_pendiente INTEGER NOT NULL DEFAULT 0');
  if (!deTurnos.includes('nube_enviado')) base.exec('ALTER TABLE turnos ADD COLUMN nube_enviado INTEGER NOT NULL DEFAULT 0');
}

// config.json es la semilla; en runtime la fuente de verdad de precios es la DB.
function sembrarServicios(servicios) {
  const up = db.prepare(`
    INSERT INTO servicios (id, nombre, duracion_min, precio, sena, catalogo_id, alias, activo)
    VALUES (@id, @nombre, @duracion_min, @precio, @sena, @catalogo_id, @alias, 1)
    ON CONFLICT(id) DO UPDATE SET
      nombre = excluded.nombre, duracion_min = excluded.duracion_min,
      precio = excluded.precio, sena = excluded.sena, catalogo_id = excluded.catalogo_id,
      alias = excluded.alias
  `);
  // Un servicio que ya no está en la lista (lo borraron en la app de Nodo Sur, o de config.json) deja de ofrecerse. No se borra:
  // los turnos viejos lo siguen nombrando.
  const apagarResto = db.prepare(`UPDATE servicios SET activo = CASE WHEN id IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END`);
  const tx = db.transaction((lista) => {
    lista.forEach((s) => up.run({
      ...s,
      catalogo_id: s.catalogo_id ?? '',
      alias: Array.isArray(s.alias) ? s.alias.join(',') : (s.alias ?? ''),
    }));
    if (lista.length) apagarResto.run(JSON.stringify(lista.map((s) => s.id)));
  });
  tx(servicios);
}

function obtener() {
  if (!db) throw new Error('DB no inicializada: llamá abrir() primero');
  return db;
}

module.exports = { abrir, sembrarServicios, obtener };
