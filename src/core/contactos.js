// Genera tarjetas de contacto .vcf para que la dueña se guarde a las clientas
// en la agenda del celular con un toque.
//
// Por qué así: ni Baileys ni WhatsApp permiten agregar contactos (WhatsApp LEE
// la agenda de Android, no escribe en ella), y termux-api solo sabe listar
// contactos. El .vcf es el formato que entienden todos los teléfonos.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'data', 'contactos');

function escapar(t) {
  return String(t || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
}

// El nombre lleva un prefijo configurable para que en la agenda queden todas
// juntas y se distingan de los contactos personales de la dueña.
function nombreParaAgenda(config, clienta) {
  const prefijo = config.contactos?.prefijo ?? '';
  return `${prefijo}${clienta.nombre || clienta.telefono}`;
}

function tarjeta(config, clienta, extra = {}) {
  const nombre = nombreParaAgenda(config, clienta);
  const notas = [
    `Clienta de ${config.negocio.nombre}`,
    extra.servicio ? `Último servicio: ${extra.servicio}` : null,
    clienta.creada_en ? `Primer contacto: ${clienta.creada_en.slice(0, 10)}` : null,
  ].filter(Boolean).join('. ');

  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${escapar(nombre)}`,
    `N:${escapar(nombre)};;;;`,
    `TEL;TYPE=CELL:+${clienta.telefono}`,
    `NOTE:${escapar(notas)}`,
    `ORG:${escapar(config.negocio.nombre)}`,
    'END:VCARD',
  ].join('\r\n');
}

// Una clienta → un archivo listo para adjuntar.
function archivoDeClienta(config, clienta, extra) {
  fs.mkdirSync(DIR, { recursive: true });
  const ruta = path.join(DIR, `clienta-${clienta.telefono}.vcf`);
  fs.writeFileSync(ruta, tarjeta(config, clienta, extra) + '\r\n', 'utf8');
  return {
    ruta,
    // Conservamos tildes y ñ; sacamos solo lo que rompe nombres de archivo
    nombre: `${(clienta.nombre || clienta.telefono).replace(/[\\/:*?"<>|]/g, '').trim()}.vcf`,
    mime: 'text/vcard',
  };
}

// Todas las clientas en un solo archivo (para "pasame todos los contactos").
// Android importa las tarjetas de a una desde el mismo .vcf.
function archivoDeTodas(config, clientas) {
  fs.mkdirSync(DIR, { recursive: true });
  const ruta = path.join(DIR, 'clientas.vcf');
  fs.writeFileSync(ruta, clientas.map((c) => tarjeta(config, c)).join('\r\n') + '\r\n', 'utf8');
  return { ruta, nombre: 'clientas.vcf', mime: 'text/vcard' };
}

module.exports = { archivoDeClienta, archivoDeTodas, tarjeta };
