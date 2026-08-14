// Recordatorios 24 hs antes + vencimiento de señas + resúmenes a la dueña.
// tick() corre por cron cada pocos minutos Y al arrancar el bot: como la
// consulta busca "confirmados sin recordatorio con inicio dentro de las
// próximas N horas", el catch-up post-reinicio sale gratis.
const qTurnos = require('../db/consultas/turnos');
const fechas = require('./fechas');
const senasFlujo = require('./flujos/senas');
const notif = require('./notificaciones');

function tick(config) {
  const salientes = [];
  const ahora = fechas.aTexto(fechas.ahora());
  const hasta = fechas.sumarMinutos(ahora, config.recordatorios.horas_antes * 60);

  // 1) Recordatorios pendientes (incluye los que quedaron colgados por una caída)
  for (const t of qTurnos.pendientesDeRecordatorio(ahora, hasta)) {
    salientes.push({
      para: t.telefono,
      texto: `¡Hola ${t.clienta_nombre || ''}! 👋 Te recordamos tu turno de mañana:\n\n💅 ${t.servicio}\n📅 ${fechas.diaLindo(t.inicio.slice(0, 10))} a las ${t.inicio.slice(11)}\n\nRespondé *CONFIRMO* para confirmar o *CANCELAR* si no llegás (así liberamos el horario).`,
    });
    qTurnos.marcarRecordatorioEnviado(t.id);
  }

  // 2) Señas vencidas → liberar horario y avisar
  return salientes.concat(senasFlujo.vencerPendientes(config));
}

function agendaDiaria(config) {
  const hoy = fechas.hoyYmd();
  return [notif.agendaDiaria(config, qTurnos.delDia(hoy), hoy)];
}

function resumenSemanal(config) {
  const desde = fechas.aTexto(fechas.ahora());
  const hasta = fechas.sumarMinutos(desde, 7 * 24 * 60);
  return [notif.resumenSemanal(config, qTurnos.entreFechas(desde, hasta))];
}

module.exports = { tick, agendaDiaria, resumenSemanal };
