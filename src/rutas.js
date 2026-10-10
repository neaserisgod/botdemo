// Dónde guarda el bot sus datos (sesión de WhatsApp, base, comprobantes, la cuenta de Nodo Sur). Por defecto data/ al lado del
// código, como siempre. Adentro de la app Nodo Sur Servicios (sin Termux) el código se reemplaza con cada actualización de la
// app, así que los datos van aparte: la app pasa DIR_DATOS.
const path = require('path');

const dirDatos = () => process.env.DIR_DATOS || path.join(__dirname, '..', 'data');
const enDatos = (...partes) => path.join(dirDatos(), ...partes);

module.exports = { dirDatos, enDatos };
