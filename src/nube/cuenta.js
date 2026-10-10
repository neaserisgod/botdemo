// La cuenta de Nodo Sur a la que está vinculado este bot (data/nodosur.json, fuera del repo): el sitio, el token del
// equipo (tipo bot, dura un año y se renueva solo con el ping) y el cursor de pedidos ya revisados. Sin este archivo el
// bot anda solo con su config.json, como antes.
const fs = require('fs');
const path = require('path');

const { dirDatos } = require('../rutas');
const ruta = () => path.join(dirDatos(), 'nodosur.json');

function leer() {
  try {
    const c = JSON.parse(fs.readFileSync(ruta(), 'utf8'));
    return c && c.token && c.sitio ? c : null;
  } catch { return null; }
}

// Escritura atómica (archivo temporal + rename): un corte de luz a mitad no deja el token roto.
function guardar(cuenta) {
  fs.mkdirSync(dirDatos(), { recursive: true });
  const tmp = `${ruta()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cuenta, null, 2));
  fs.renameSync(tmp, ruta());
}

function actualizar(cambios) {
  const c = leer();
  if (c) guardar({ ...c, ...cambios });
}

module.exports = { leer, guardar, actualizar, dirDatos, ruta };
