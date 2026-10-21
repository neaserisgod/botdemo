// Las fotos de los platos que se sacan en la app (El dueño, 2026-10-21) y que el bot pone en el catálogo de WhatsApp Business.
// El catálogo de Nodo Sur dice la versión de la foto de cada plato (`foto`); acá se baja una vez y se guarda en data/fotos/, y se
// anota qué versión quedó puesta en WhatsApp (data/fotos-espejo.json) para cambiarla solo cuando se saca otra. WhatsApp no dice
// qué foto tiene cada producto, así que lo anotado es la única forma de saberlo.
const fs = require('fs');
const path = require('path');

const EXTENSION = { 'image/png': 'png' };

function crearFotos({ cliente, dir }) {
  const carpeta = path.join(dir, 'fotos');
  const rutaAnotadas = path.join(dir, 'fotos-espejo.json');
  let aplicadas = new Map();
  try { aplicadas = new Map(Object.entries(JSON.parse(fs.readFileSync(rutaAnotadas, 'utf8')))); } catch { /* primera vez */ }

  // El archivo de esa versión, bajándolo si hace falta. Las versiones viejas del mismo plato se borran.
  async function ruta(gid, version) {
    fs.mkdirSync(carpeta, { recursive: true });
    const propias = fs.readdirSync(carpeta).filter((f) => f.startsWith(`${gid}-`));
    const ya = propias.find((f) => f.startsWith(`${gid}-${version}.`));
    if (ya) return path.join(carpeta, ya);
    const { bytes, tipo } = await cliente.foto(gid);
    const archivo = path.join(carpeta, `${gid}-${version}.${EXTENSION[tipo] || 'jpg'}`);
    fs.writeFileSync(`${archivo}.tmp`, bytes);
    fs.renameSync(`${archivo}.tmp`, archivo);
    for (const f of propias) fs.rmSync(path.join(carpeta, f), { force: true });
    return archivo;
  }

  // `version` null: quedó la foto genérica.
  function anotar(gid, version) {
    aplicadas.set(gid, version);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${rutaAnotadas}.tmp`, JSON.stringify(Object.fromEntries(aplicadas)));
      fs.renameSync(`${rutaAnotadas}.tmp`, rutaAnotadas);
    } catch (e) { console.error('No pude anotar las fotos del catálogo:', e.message); }
  }

  return { ruta, anotar, aplicadas: () => aplicadas };
}

module.exports = { crearFotos };
