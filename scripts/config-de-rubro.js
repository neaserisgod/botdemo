#!/usr/bin/env node
// Arma el config.json de un negocio nuevo a partir de la plantilla de su rubro:
// la base de config.example.json, con el rubro y sus servicios de ejemplo.
// Después se editan los datos propios (nombre, dirección, números, horarios,
// precios) con `nano config.json`.
//
//   node scripts/config-de-rubro.js barberia
//   node scripts/config-de-rubro.js unas
//
// No pisa un config.json que ya exista: ahí están los datos de un cliente.
const fs = require('fs');
const path = require('path');
const { PLANTILLAS, plantillaDe, claveDeRubro, serviciosDe } = require('../src/plantillas');
const { armar, ejemplo, validar } = require('../src/config');

const RAIZ = path.join(__dirname, '..');
const DESTINO = path.join(RAIZ, 'config.json');

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
  negocio: { ...base.negocio, nombre: `${plantillaDe(rubro).nombre} (DEMO)`, rubro },
  servicios: serviciosDe(rubro),
};

// Se valida lo que va a quedar, igual que al arrancar el bot.
const problemas = validar(armar(base, propio));
if (problemas.length) {
  console.error('La plantilla no pasa la validación:\n' + problemas.map((p) => `  • ${p}`).join('\n'));
  process.exit(1);
}

fs.writeFileSync(DESTINO, JSON.stringify({ ...base, ...propio }, null, 2) + '\n', 'utf8');
console.log(`config.json listo para ${plantillaDe(rubro).nombre}. Cargá los datos del negocio:  nano config.json`);
