// Comandos de la dueña (identificada por número; nunca entra al flujo de clienta).
// !hoy  !semana  !turno N  !ok N  !no N  !anular N  !precio [id monto]
const qTurnos = require('../db/consultas/turnos');
const qSenas = require('../db/consultas/senas');
const qServicios = require('../db/consultas/servicios');
const fechas = require('./fechas');
const notif = require('./notificaciones');

function procesar(config, msj) {
  const t = (msj.texto || '').trim();
  const [cmd, ...args] = t.split(/\s+/);
  const responder = (texto) => [{ para: config.numero_duena, texto }];

  switch (cmd.toLowerCase()) {
    case '!hoy': {
      const hoy = fechas.hoyYmd();
      return [notif.agendaDiaria(config, qTurnos.delDia(hoy), hoy)];
    }

    case '!semana': {
      const desde = fechas.aTexto(fechas.ahora());
      const hasta = fechas.sumarMinutos(desde, 7 * 24 * 60);
      return [notif.resumenSemanal(config, qTurnos.entreFechas(desde, hasta))];
    }

    case '!turno': {
      const turno = qTurnos.porId(parseInt(args[0], 10));
      if (!turno) return responder(`No encontré el turno #${args[0]}.`);
      const sena = qSenas.porTurno(turno.id);
      const lineasSena = sena
        ? `\nSeña: ${sena.estado} ($${sena.monto_esperado})${sena.nro_operacion ? ` op. ${sena.nro_operacion}` : ''}`
        : '';
      return responder(
        `*Turno #${turno.id}* — ${turno.estado}\n📅 ${fechas.diaLindo(turno.inicio.slice(0, 10))} ${turno.inicio.slice(11)}–${turno.fin.slice(11)}\n💅 ${turno.servicio} ($${turno.precio})\n👤 ${turno.clienta_nombre || 'sin nombre'} — ${turno.telefono}${lineasSena}`);
    }

    case '!ok': case '!no': {
      const turno = qTurnos.porId(parseInt(args[0], 10));
      if (!turno) return responder(`No encontré el turno #${args[0]}.`);
      const sena = qSenas.porTurno(turno.id);
      if (!sena || sena.estado !== 'a_revisar') {
        return responder(`El turno #${turno.id} no tiene ninguna seña a revisar (estado: ${sena ? sena.estado : 'sin seña'}).`);
      }
      if (cmd.toLowerCase() === '!ok') {
        qSenas.cambiarEstado(sena.id, 'verificado', 'duena');
        qTurnos.cambiarEstado(turno.id, 'confirmado');
        return [
          { para: config.numero_duena, texto: `👍 Seña del turno #${turno.id} aprobada. Le aviso a la clienta.` },
          { para: turno.telefono, texto: `¡Seña verificada! ✅ Tu turno del ${fechas.diaLindo(turno.inicio.slice(0, 10))} a las ${turno.inicio.slice(11)} quedó confirmado. ¡Te esperamos!` },
        ];
      }
      qSenas.cambiarEstado(sena.id, 'rechazada', 'duena');
      qTurnos.cambiarEstado(turno.id, 'cancelado');
      return [
        { para: config.numero_duena, texto: `👎 Seña del turno #${turno.id} rechazada. El horario quedó libre y le aviso a la clienta.` },
        { para: turno.telefono, texto: `Hubo un problema con el comprobante de tu seña y no pudimos confirmar el turno 😕 Escribinos *4* para hablar con la dueña y resolverlo.` },
      ];
    }

    case '!anular': {
      const turno = qTurnos.porId(parseInt(args[0], 10));
      if (!turno) return responder(`No encontré el turno #${args[0]}.`);
      if (!['pendiente_sena', 'confirmado'].includes(turno.estado)) {
        return responder(`El turno #${turno.id} ya está ${turno.estado}.`);
      }
      qTurnos.cambiarEstado(turno.id, 'anulado');
      return [
        { para: config.numero_duena, texto: `🗑️ Turno #${turno.id} anulado. El horario quedó libre y le aviso a la clienta.` },
        { para: turno.telefono, texto: `Hola ${turno.clienta_nombre || ''} 👋 Lamentablemente tuvimos que cancelar tu turno del ${fechas.diaLindo(turno.inicio.slice(0, 10))} a las ${turno.inicio.slice(11)}. Escribí *hola* para reprogramarlo, ¡disculpá las molestias!` },
      ];
    }

    case '!precio': {
      if (args.length === 0) {
        const lista = qServicios.activos().map(
          (s) => `*${s.id}* — ${s.nombre}: $${s.precio}${s.sena ? ` (seña $${s.sena})` : ''}`
        ).join('\n');
        return responder(`💰 *Precios actuales:*\n${lista}\n\nPara cambiar: *!precio <id> <monto>*`);
      }
      const s = qServicios.porId(parseInt(args[0], 10));
      const monto = parseInt(args[1], 10);
      if (!s || !monto || monto <= 0) return responder('Formato: *!precio <id> <monto>* — ej: !precio 1 20000');
      qServicios.cambiarPrecio(s.id, monto);
      return responder(`Listo: *${s.nombre}* ahora sale $${monto}.\n(Acordate de actualizar el catálogo de WhatsApp a mano 😉)`);
    }

    default:
      return responder(
        `Comandos disponibles:\n*!hoy* — agenda de hoy\n*!semana* — próximos 7 días\n*!turno N* — detalle de un turno\n*!ok N* / *!no N* — aprobar/rechazar seña\n*!anular N* — anular turno\n*!precio* — ver/cambiar precios`);
  }
}

module.exports = { procesar };
