// Agenda: días y horarios libres según config.horarios, sin solapamientos.
const turnos = require('../db/consultas/turnos');
const fechas = require('./fechas');
const nlu = require('./nlu');

// Días con al menos un slot libre para un servicio dado. Opciones: `desde` ('YYYY-MM-DD', "la semana que viene"),
// `franja` (solo días con lugar "a la tarde") y `excluirId` (el turno que se está cambiando).
function diasDisponibles(config, servicio, { desde = null, franja = null, excluirId = 0 } = {}) {
  const dias = [];
  const hoy = new Date();
  for (let i = 0; i < config.turnos.dias_hacia_adelante; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + i);
    const ymd = fechas.aTexto(d).slice(0, 10);
    if (desde && ymd < desde) continue;
    if (horariosLibres(config, servicio, ymd, excluirId).some((h) => nlu.enFranja(h, franja))) {
      dias.push(ymd);
    }
    if (dias.length >= 7) break; // mostramos hasta 7 opciones de día
  }
  return dias;
}

// Slots libres de un día para un servicio (respeta duración y anticipación mínima).
function horariosLibres(config, servicio, fechaYmd, excluirId = 0) {
  const franja = config.horarios[fechas.nombreDia(fechaYmd)];
  if (!franja) return []; // día cerrado

  const paso = config.turnos.intervalo_slot_min;
  const minimo = fechas.aTexto(new Date(
    Date.now() + config.turnos.anticipacion_minima_horas * 3600000
  ));

  const libres = [];
  let slot = `${fechaYmd} ${franja.desde}`;
  const cierre = `${fechaYmd} ${franja.hasta}`;

  while (fechas.sumarMinutos(slot, servicio.duracion_min) <= cierre) {
    const fin = fechas.sumarMinutos(slot, servicio.duracion_min);
    if (slot >= minimo && !turnos.haySolapamiento(slot, fin, excluirId)) {
      libres.push(slot.slice(11)); // 'HH:MM'
    }
    slot = fechas.sumarMinutos(slot, paso);
  }
  return libres;
}

// ¿El negocio está abierto a esa hora? En ese día, o en alguno si no se sabe el día. Para leer "a las 5" como 17:00.
function abiertoA(config, hora, fechaYmd = null) {
  const dias = fechaYmd ? [config.horarios[fechas.nombreDia(fechaYmd)]] : Object.values(config.horarios);
  return dias.some((f) => f && hora >= f.desde && hora < f.hasta);
}

module.exports = { diasDisponibles, horariosLibres, abiertoA };
