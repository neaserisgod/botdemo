// El estado del bot para la app que lo trae adentro (Nodo Sur Servicios, sin Termux): si está conectado a WhatsApp, el código de
// vinculación mientras haga falta, desde cuándo y el último mensaje. Va a estado.json en la carpeta de datos, que la app lee
// (no hay otra forma de hablar con un proceso suelto). Afuera de la app no molesta: es un archivo chico.
const fs = require('fs');
const { enDatos } = require('./rutas');

let estado = {};
try { estado = JSON.parse(fs.readFileSync(enDatos('estado.json'), 'utf8')); } catch { /* primera vez */ }

// Escritura atómica: la app puede leerlo justo mientras se escribe.
function anotar(cambios) {
  estado = { ...estado, ...cambios, pid: process.pid, actualizado: Date.now() };
  try {
    fs.mkdirSync(enDatos(), { recursive: true });
    const tmp = enDatos('estado.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(estado));
    fs.renameSync(tmp, enDatos('estado.json'));
  } catch { /* sin disco no hay estado, el bot sigue */ }
}

// Un mensaje cada tanto alcanza para "último mensaje hace X": no escribir en disco con cada uno.
let ultimoAnotado = 0;
function mensajeRecibido(t = Date.now()) {
  if (t - ultimoAnotado < 30000) return;
  ultimoAnotado = t;
  anotar({ ultimoMensaje: t });
}

module.exports = { anotar, mensajeRecibido };
