// Mensajes hacia la dueña. Cada función devuelve un mensaje saliente
// { para, texto, imagenRuta? } listo para que el adaptador lo mande.
const fechas = require('./fechas');
const calendario = require('./calendario');
const contactos = require('./contactos');
const qTurnos = require('../db/consultas/turnos');

// Invitación .ics para que la dueña se agregue el turno al calendario del celu.
// Devuelve [] si está desactivado o si algo falla: nunca frena una confirmación.
function invitacionCalendario(config, turno, opciones) {
  if (config.calendario && config.calendario.habilitado === false) return [];
  try {
    const adjunto = calendario.archivoDeTurno(config, turno, opciones);
    return [{
      para: config.numero_duena,
      adjunto,
      texto: opciones?.cancelado
        ? `🗓️ Cancelación del turno #${turno.id} para tu calendario.`
        : `🗓️ Tocá el archivo para agregarlo a tu calendario.`,
      demora: 1500, // que llegue después del aviso del turno
    }];
  } catch (e) {
    console.error('No pude generar el .ics:', e.message);
    return [];
  }
}

function linea(t) {
  const quien = t.clienta_nombre || t.telefono;
  return `#${t.id} ${t.inicio.slice(11)} — ${t.servicio} — ${quien}${t.estado === 'pendiente_sena' ? ' ⏳(seña pendiente)' : ''}`;
}

function turnoSenado(config, turno, datos, rutaImagen) {
  return {
    para: config.numero_duena,
    imagenRuta: rutaImagen,
    texto: `💰 *Turno señado* #${turno.id}\n${fechas.diaLindo(turno.inicio.slice(0, 10))} ${turno.inicio.slice(11)} — ${turno.servicio}\nClienta: ${turno.clienta_nombre || turno.telefono}\nSeña: $${datos.monto} (op. ${datos.nroOperacion})`,
  };
}

function senaARevisar(config, turno, motivo, rutaImagen) {
  return {
    para: config.numero_duena,
    imagenRuta: rutaImagen,
    texto: `⚠️ *Seña a revisar* — turno #${turno.id}\n${fechas.diaLindo(turno.inicio.slice(0, 10))} ${turno.inicio.slice(11)} — ${turno.servicio}\nClienta: ${turno.clienta_nombre || turno.telefono}\nMotivo: ${motivo}\n\nRespondé *!ok ${turno.id}* para aprobar o *!no ${turno.id}* para rechazar.`,
  };
}

function senaVencida(config, turno) {
  return {
    para: config.numero_duena,
    texto: `⌛ Se venció la seña del turno #${turno.id} (${fechas.diaLindo(turno.inicio.slice(0, 10))} ${turno.inicio.slice(11)}). El horario quedó libre.`,
  };
}

function turnoConfirmado(config, turno) {
  return {
    para: config.numero_duena,
    texto: `✅ *Turno nuevo* #${turno.id}\n${fechas.diaLindo(turno.inicio.slice(0, 10))} ${turno.inicio.slice(11)} — ${turno.servicio}\nClienta: ${turno.clienta_nombre || turno.telefono}`,
  };
}

function cancelacion(config, turno, origen) {
  return {
    para: config.numero_duena,
    texto: `❌ *Cancelación* — turno #${turno.id}\n${fechas.diaLindo(turno.inicio.slice(0, 10))} ${turno.inicio.slice(11)} — ${turno.servicio}\nClienta: ${turno.clienta_nombre || turno.telefono}\n(${origen}) El horario quedó libre.`,
  };
}

function derivacion(config, clienta, textoCitado) {
  return {
    para: config.numero_duena,
    texto: `🙋 *Necesita atención humana*\nClienta: ${clienta.nombre || clienta.telefono} (${clienta.telefono})\nÚltimo mensaje:\n> ${textoCitado}\n\nEl bot deja de responderle por 12 hs; contestale directo desde este número.`,
  };
}

function agendaDiaria(config, turnosDia, fechaYmd) {
  const cuerpo = turnosDia.length
    ? turnosDia.map(linea).join('\n')
    : 'Sin turnos por ahora.';
  return {
    para: config.numero_duena,
    texto: `📋 *Agenda de hoy* — ${fechas.diaLindo(fechaYmd)}\n${cuerpo}`,
  };
}

function resumenSemanal(config, turnosSemana) {
  const porDia = {};
  for (const t of turnosSemana) {
    const d = t.inicio.slice(0, 10);
    (porDia[d] = porDia[d] || []).push(t);
  }
  const partes = Object.keys(porDia).sort().map(
    (d) => `*${fechas.diaLindo(d)}*\n${porDia[d].map(linea).join('\n')}`
  );
  return {
    para: config.numero_duena,
    texto: `🗓️ *Semana que viene*\n${partes.length ? partes.join('\n\n') : 'Sin turnos todavía.'}`,
  };
}

// Tarjeta de contacto de la clienta, para que la dueña la guarde en la agenda
// con el nombre que la propia clienta dio. Solo la primera vez que reserva.
function tarjetaContacto(config, clienta, turno) {
  if (config.contactos && config.contactos.habilitado === false) return [];
  if (qTurnos.contarDeClienta(clienta.id) > 1) return []; // ya se la mandamos
  try {
    const adjunto = contactos.archivoDeClienta(config, clienta, { servicio: turno?.servicio });
    return [{
      para: config.numero_duena,
      adjunto,
      texto: `👤 *${clienta.nombre || clienta.telefono}* es clienta nueva. Tocá el archivo para guardarla en tu agenda.`,
      demora: 2500, // después del turno y del calendario
    }];
  } catch (e) {
    console.error('No pude generar el .vcf:', e.message);
    return [];
  }
}

module.exports = {
  turnoSenado, senaARevisar, senaVencida, turnoConfirmado,
  cancelacion, derivacion, agendaDiaria, resumenSemanal, linea,
  invitacionCalendario, tarjetaContacto,
};
