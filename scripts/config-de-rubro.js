#!/usr/bin/env node
// Arma el config.json de un negocio nuevo a partir de la plantilla de su rubro:
// la base de config.example.json, con el rubro y sus servicios de ejemplo.
// Después se editan los datos propios (nombre, dirección, números, horarios,
// precios) con `nano config.json`.
//
//   node scripts/config-de-rubro.js barberia
//   node scripts/config-de-rubro.js almacen --nombre "La Plazoleta" --numero-bot 5492944111111 --numero-duena 5492944222222
//
// Los datos del negocio también se pueden pasar acá (el instalador los pregunta uno por uno, así nadie tiene que abrir
// nano): --nombre, --direccion, --numero-bot (el chip del WhatsApp que atiende), --numero-duena (a quien le avisa) y
// --numero-soporte (a quien le llega el latido diario; por defecto, el soporte de Nodo Sur).
//
// No pisa un config.json que ya exista: ahí están los datos de un cliente.
const fs = require('fs');
const path = require('path');
const { PLANTILLAS, plantillaDe, claveDeRubro, serviciosDe } = require('../src/plantillas');
const { armar, ejemplo, validar } = require('../src/config');

const RAIZ = path.join(__dirname, '..');
const DESTINO = path.join(RAIZ, 'config.json');

// Soporte de Nodo Sur (el WhatsApp de contacto de horsepos.com): recibe solo el latido de salud del sistema.
const SOPORTE_NODO_SUR = '5492944796044';

// Un celular argentino como lo escribe cualquiera ("2944 111111", "02944-111111", "+54 9 2944 111111") al formato de
// WhatsApp: 549 + característica sin el 0 + número sin el 15. Lo que no se reconoce queda como vino y lo frena la validación.
function numeroAr(texto) {
  let d = String(texto).replace(/\D/g, '');
  if (d.startsWith('549')) return d;
  if (d.startsWith('54')) return `549${d.slice(2)}`;
  if (d.startsWith('0')) d = d.slice(1);
  return d.length === 10 ? `549${d}` : d;
}

function opciones(args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const m = /^--([a-z-]+)$/.exec(args[i]);
    if (m && args[i + 1] !== undefined) o[m[1]] = args[++i].trim();
  }
  return o;
}
const op = opciones(process.argv.slice(3));
const rubro = claveDeRubro(process.argv[2]);
if (!plantillaDe(rubro)) {
  console.error(`Decime el rubro: ${Object.keys(PLANTILLAS).join(' o ')}`);
  console.error('  node scripts/config-de-rubro.js barberia');
  process.exit(1);
}
if (fs.existsSync(DESTINO)) {
  console.error('Ya hay un config.json: no lo piso (tiene los datos del cliente).');
  console.error('Si de verdad querés empezar de cero, borralo primero.');
  process.exit(1);
}

const base = ejemplo();
const propio = {
  negocio: {
    ...base.negocio, rubro,
    nombre: op.nombre || `${plantillaDe(rubro).nombre} (DEMO)`,
    ...(op.direccion ? { direccion: op.direccion } : {}),
  },
  ...(op['numero-bot'] ? { numero_actual: numeroAr(op['numero-bot']) } : {}),
  ...(op['numero-duena'] ? { numero_duena: numeroAr(op['numero-duena']) } : {}),
  numero_soporte: numeroAr(op['numero-soporte'] || SOPORTE_NODO_SUR),
  servicios: serviciosDe(rubro),
};

// Se valida lo que va a quedar, igual que al arrancar el bot.
const problemas = validar(armar(base, propio));
if (problemas.length) {
  console.error('Hay datos para revisar:\n' + problemas.map((p) => `  • ${p}`).join('\n'));
  process.exit(1);
}

fs.writeFileSync(DESTINO, JSON.stringify({ ...base, ...propio }, null, 2) + '\n', 'utf8');
console.log(`config.json listo para ${plantillaDe(rubro).nombre}. Cargá los datos del negocio:  nano config.json`);
