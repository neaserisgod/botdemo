// Genera archivos .ics (iCalendar) para que la dueña se agregue los turnos
// al calendario de su celular con un toque.
//
// Por qué .ics y no la API de Google Calendar: no necesita credenciales, ni
// OAuth, ni internet, ni que la dueña tenga cuenta de Google. Android e iOS
// abren el adjunto y ofrecen "Agregar al calendario" de una.
const fs = require('fs');
const path = require('path');
const fechas = require('./fechas');

const DIR = path.join(__dirname, '..', '..', 'data', 'calendario');

// '2026-08-15 10:30' → '20260815T103000' (hora local, sin zona: el celu lo
// interpreta con su propia zona horaria, que es la del negocio)
function aFormatoIcs(textoFecha) {
  return textoFecha.replace(/[-:]/g, '').replace(' ', 'T') + '00';
}

function escapar(t) {
  return String(t || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
}

// Un turno = un evento. El UID se arma con el id del turno, así el calendario
// reconoce actualizaciones y cancelaciones del mismo evento.
function eventoDeTurno(config, turno, { cancelado = false } = {}) {
  const quien = turno.clienta_nombre || turno.telefono;
  return [
    'BEGIN:VEVENT',
    `UID:turno-${turno.id}@bot-turnos`,
    `DTSTAMP:${aFormatoIcs(fechas.aTexto(fechas.ahora()))}`,
    `DTSTART:${aFormatoIcs(turno.inicio)}`,
    `DTEND:${aFormatoIcs(turno.fin)}`,
    `SUMMARY:${escapar(`${turno.servicio} — ${quien}`)}`,
    `DESCRIPTION:${escapar(`Turno #${turno.id}\nClienta: ${quien}\nTeléfono: ${turno.telefono}\nServicio: ${turno.servicio}\nPrecio: $${turno.precio}`)}`,
    `LOCATION:${escapar(config.negocio.direccion)}`,
    cancelado ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    'BEGIN:VALARM',            // recordatorio 30 min antes, en el celu de ella
    'TRIGGER:-PT30M',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapar(`En 30 min: ${turno.servicio} con ${quien}`)}`,
    'END:VALARM',
    'END:VEVENT',
  ].join('\r\n');
}

function envolver(eventos, { cancelacion = false } = {}) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//bot-turnos//ES',
    'CALSCALE:GREGORIAN',
    `METHOD:${cancelacion ? 'CANCEL' : 'PUBLISH'}`,
    ...eventos,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

// Escribe el .ics de un turno y devuelve el adjunto listo para mandar.
function archivoDeTurno(config, turno, opciones) {
  fs.mkdirSync(DIR, { recursive: true });
  const ruta = path.join(DIR, `turno-${turno.id}${opciones?.cancelado ? '-cancelado' : ''}.ics`);
  fs.writeFileSync(ruta, envolver([eventoDeTurno(config, turno, opciones)],
    { cancelacion: opciones?.cancelado }), 'utf8');
  return {
    ruta,
    nombre: `turno-${turno.id}.ics`,
    mime: 'text/calendar',
  };
}

// Calendario completo (para el endpoint de suscripción del panel).
function textoDeTurnos(config, turnos) {
  return envolver(turnos.map((t) => eventoDeTurno(config, t)));
}

module.exports = { archivoDeTurno, textoDeTurnos, eventoDeTurno };
