// Salud del sistema: eventos de conectividad, batería (Termux) y latido diario.
// El latido va a MI número (soporte) y solo dice que el bot está vivo:
// nunca contenido del cliente.
const { execFileSync } = require('child_process');
const qEventos = require('../db/consultas/eventos');

function registrarArranque() {
  qEventos.registrar('arranque', `pid ${process.pid}`);
}

function registrarCaida(detalle) {
  qEventos.registrar('caida', detalle);
}

// Al reconectar: registra el evento y avisa a la dueña cuánto estuvo caído.
function alReconectar(config) {
  const ultimaCaida = qEventos.ultimoDeTipo('caida');
  qEventos.registrar('reconexion', null);
  if (!ultimaCaida) return [];
  const ultimaReconexion = qEventos.ultimoDeTipo('reconexion');
  // Solo avisar si la caída es más reciente que la anteúltima reconexión
  if (ultimaReconexion && ultimaCaida.creado_en > ultimaReconexion.creado_en) return [];
  return [{
    para: config.numero_duena,
    texto: `📶 El bot se reconectó. Estuvo sin conexión desde ${ultimaCaida.creado_en}. Si alguna clienta escribió en ese rato, ya le está respondiendo.`,
  }];
}

// Batería vía termux-battery-status (solo existe en el celu con Termux:API).
function estadoBateria() {
  try {
    const salida = execFileSync('termux-battery-status', [], { timeout: 5000, encoding: 'utf8' });
    return JSON.parse(salida); // { percentage, plugged, status, ... }
  } catch {
    return null; // PC o sin Termux:API
  }
}

// Corte de luz: el celu quedó desenchufado. Avisa una sola vez por corte.
let avisadoDesenchufado = false;
function chequearBateria(config) {
  const bat = estadoBateria();
  if (!bat) return [];
  const desenchufado = bat.plugged === 'UNPLUGGED';
  if (desenchufado && !avisadoDesenchufado) {
    avisadoDesenchufado = true;
    qEventos.registrar('bateria', `desenchufado al ${bat.percentage}%`);
    return [{
      para: config.numero_duena,
      texto: `🔋 Ojo: el celu del bot quedó sin corriente (¿se cortó la luz?). Batería: ${bat.percentage}%. El bot sigue andando con datos móviles mientras dure la batería.`,
    }];
  }
  if (!desenchufado && avisadoDesenchufado) {
    avisadoDesenchufado = false;
    qEventos.registrar('bateria', `enchufado de nuevo al ${bat.percentage}%`);
    return [{ para: config.numero_duena, texto: `🔌 Volvió la corriente al celu del bot (batería ${bat.percentage}%).` }];
  }
  return [];
}

// Latido diario a mi número: solo salud, cero datos del negocio.
function latido(config) {
  qEventos.registrar('latido', null);
  const bat = estadoBateria();
  const batTxt = bat ? ` | batería ${bat.percentage}%` : '';
  const upHoras = Math.floor(process.uptime() / 3600);
  return [{
    para: config.numero_soporte,
    texto: `🤖 [${config.negocio.nombre}] bot activo | uptime ${upHoras} hs${batTxt}`,
  }];
}

module.exports = { registrarArranque, registrarCaida, alReconectar, chequearBateria, latido };
