// Elige el motor de SQLite disponible, sin cambiar el resto del código.
//
//  1) better-sqlite3  → PC (rápido, maduro). Necesita compilar: en Termux falla
//     (node-gyp no sabe la ruta del NDK de Android).
//  2) node:sqlite     → el SQLite que viene DENTRO de Node 22.5+. No compila
//     nada, así que en el celu funciona siempre.
//
// La API que usa el proyecto es prepare/exec/transaction: la envolvemos para
// que las dos se comporten igual.

function abrirBase(ruta) {
  // 1) better-sqlite3 si está instalado y compilado
  try {
    const Database = require('better-sqlite3');
    const db = new Database(ruta);
    db.motor = 'better-sqlite3';
    return db;
  } catch (e) {
    if (process.env.DEPURAR) console.log('better-sqlite3 no disponible:', e.message);
  }

  // 2) SQLite incorporado en Node (22.5+)
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    throw new Error(
      'No hay motor de SQLite disponible.\n' +
      `   Node instalado: ${process.version} (hace falta 22.5 o mayor para el SQLite incorporado)\n` +
      '   Opciones: actualizá Node (pkg upgrade nodejs-lts) o instalá better-sqlite3.'
    );
  }
  return envolver(new DatabaseSync(ruta));
}

// node:sqlite no trae db.transaction() como better-sqlite3: lo emulamos.
function envolver(db) {
  db.motor = 'node:sqlite';

  db.transaction = (fn) => (...args) => {
    db.exec('BEGIN');
    try {
      const r = fn(...args);
      db.exec('COMMIT');
      return r;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* la transacción ya murió */ }
      throw e;
    }
  };

  // run() puede devolver BigInt en lastInsertRowid; el resto del código espera
  // números comunes (los usamos como id de turno en mensajes y consultas).
  const prepareOriginal = db.prepare.bind(db);
  db.prepare = (sql) => {
    const st = prepareOriginal(sql);
    const runOriginal = st.run.bind(st);
    st.run = (...args) => {
      const r = runOriginal(...args);
      return {
        changes: Number(r.changes),
        lastInsertRowid: Number(r.lastInsertRowid),
      };
    };
    return st;
  };

  return db;
}

module.exports = { abrirBase };
