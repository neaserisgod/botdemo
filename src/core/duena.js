// Lo que le contesta el bot a la dueña. Entiende lenguaje natural
// ("qué tengo hoy", "aprobá la 5") y también los comandos con ! de siempre.
const qTurnos = require('../db/consultas/turnos');
const qSenas = require('../db/consultas/senas');
const qServicios = require('../db/consultas/servicios');
const fechas = require('./fechas');
const notif = require('./notificaciones');
const nluDuena = require('./nlu-duena');

// Acción destructiva esperando un "sí". En memoria a propósito: si el bot se
// reinicia, la confirmación se pierde y la dueña la repite (más seguro que
// ejecutar algo viejo que quedó colgado).
let pendiente = null; // { accion, id, vence }
const MINUTOS_CONFIRMACION = 5;

function procesar(config, msj) {
  const texto = (msj.texto || '').trim();
  const responder = (t) => [{ para: config.numero_duena, texto: t }];

  // ¿Está respondiendo a una confirmación?
  if (pendiente && Date.now() < pendiente.vence) {
    if (nluDuena.esSi(texto)) {
      const accion = pendiente;
      pendiente = null;
      return ejecutar(config, accion.accion, accion.id, null);
    }
    if (nluDuena.esNo(texto)) {
      pendiente = null;
      return responder('Listo, no hice nada 👍');
    }
    // Cualquier otra cosa: se interpreta como pedido nuevo y se descarta la anterior
  }
  pendiente = null;

  const r = nluDuena.interpretar(texto, qServicios.activos());

  if (!r.accion) return responder(ayuda());

  // Las acciones que borran cosas, si vinieron en lenguaje natural, se confirman
  if (r.natural && nluDuena.DESTRUCTIVAS.includes(r.accion)) {
    if (!r.id) return responder(`¿Qué turno querés ${r.accion === 'anular' ? 'anular' : 'rechazar'}? Decime el número (lo ves con *hoy* o *semana*).`);
    const turno = qTurnos.porId(r.id);
    if (!turno) return responder(`No encontré el turno #${r.id}.`);
    pendiente = { accion: r.accion, id: r.id, vence: Date.now() + MINUTOS_CONFIRMACION * 60000 };
    const que = r.accion === 'anular'
      ? `anular el turno #${turno.id} (${fechas.diaLindo(turno.inicio.slice(0, 10))} ${turno.inicio.slice(11)} — ${turno.servicio} — ${turno.clienta_nombre || turno.telefono})`
      : `rechazar la seña del turno #${turno.id} (se cancela el turno)`;
    return responder(`¿Confirmás ${que}?\n\nRespondé *sí* o *no*.`);
  }

  return ejecutar(config, r.accion, r.id, r);
}

function ejecutar(config, accion, id, r) {
  const responder = (t) => [{ para: config.numero_duena, texto: t }];

  switch (accion) {
    case 'hoy': {
      const hoy = fechas.hoyYmd();
      return [notif.agendaDiaria(config, qTurnos.delDia(hoy), hoy)];
    }

    case 'semana': {
      const desde = fechas.aTexto(fechas.ahora());
      const hasta = fechas.sumarMinutos(desde, 7 * 24 * 60);
      return [notif.resumenSemanal(config, qTurnos.entreFechas(desde, hasta))];
    }

    case 'detalle': {
      if (!id) return responder('¿De qué turno? Decime el número (lo ves con *hoy* o *semana*).');
      const turno = qTurnos.porId(id);
      if (!turno) return responder(`No encontré el turno #${id}.`);
      const sena = qSenas.porTurno(turno.id);
      const lineaSena = sena
        ? `\nSeña: ${sena.estado} ($${sena.monto_esperado})${sena.nro_operacion ? ` — op. ${sena.nro_operacion}` : ''}`
        : '';
      return responder(
        `*Turno #${turno.id}* — ${turno.estado}\n📅 ${fechas.diaLindo(turno.inicio.slice(0, 10))} ${turno.inicio.slice(11)}–${turno.fin.slice(11)}\n💅 ${turno.servicio} ($${turno.precio})\n👤 ${turno.clienta_nombre || 'sin nombre'} — ${turno.telefono}${lineaSena}`);
    }

    case 'aprobar': case 'rechazar': {
      if (!id) return responder('¿De qué turno es la seña? Decime el número.');
      const turno = qTurnos.porId(id);
      if (!turno) return responder(`No encontré el turno #${id}.`);
      const sena = qSenas.porTurno(turno.id);
      if (!sena || sena.estado !== 'a_revisar') {
        return responder(`El turno #${turno.id} no tiene ninguna seña a revisar (está: ${sena ? sena.estado : 'sin seña'}).`);
      }
      if (accion === 'aprobar') {
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

    case 'anular': {
      if (!id) return responder('¿Qué turno anulo? Decime el número.');
      const turno = qTurnos.porId(id);
      if (!turno) return responder(`No encontré el turno #${id}.`);
      if (!['pendiente_sena', 'confirmado'].includes(turno.estado)) {
        return responder(`El turno #${turno.id} ya está ${turno.estado}.`);
      }
      qTurnos.cambiarEstado(turno.id, 'anulado');
      return [
        { para: config.numero_duena, texto: `🗑️ Turno #${turno.id} anulado. El horario quedó libre y le aviso a la clienta.` },
        { para: turno.telefono, texto: `Hola ${turno.clienta_nombre || ''} 👋 Lamentablemente tuvimos que cancelar tu turno del ${fechas.diaLindo(turno.inicio.slice(0, 10))} a las ${turno.inicio.slice(11)}. Escribí *hola* para reprogramarlo, ¡disculpá las molestias!` },
      ];
    }

    case 'precio': {
      const lista = qServicios.activos().map(
        (s) => `*${s.id}* — ${s.nombre}: $${s.precio}${s.sena ? ` (seña $${s.sena})` : ''}`
      ).join('\n');
      return responder(`💰 *Precios actuales:*\n${lista}\n\nPara cambiar uno, escribime algo como:\n_"el kapping ahora sale 30000"_`);
    }

    case 'precio_set': {
      const s = r?.servicio || qServicios.porId(r?.idServicio);
      const monto = r?.monto;
      if (!s || !monto || monto <= 0) {
        return responder('No entendí qué precio cambiar. Probá: _"el kapping ahora sale 30000"_');
      }
      qServicios.cambiarPrecio(s.id, monto);
      return responder(`Listo: *${s.nombre}* ahora sale $${monto}.\n(Acordate de actualizar el catálogo de WhatsApp a mano 😉)`);
    }

    case 'ayuda': default:
      return responder(ayuda());
  }
}

function ayuda() {
  return `Escribime como te salga, te entiendo 😊\n\n` +
    `📅 *"qué tengo hoy"* — la agenda del día\n` +
    `🗓️ *"cómo viene la semana"* — próximos 7 días\n` +
    `🔍 *"quién es el turno 5"* — detalle de un turno\n` +
    `✅ *"aprobá la seña del 5"* — dar por buena una seña\n` +
    `❌ *"rechazá la 5"* — rechazar una seña\n` +
    `🗑️ *"anulá el turno 3"* — cancelar un turno\n` +
    `💰 *"precios"* — ver la lista\n` +
    `✏️ *"el kapping ahora sale 30000"* — cambiar un precio\n\n` +
    `También andan los atajos: !hoy !semana !turno N !ok N !no N !anular N !precio`;
}

module.exports = { procesar };
