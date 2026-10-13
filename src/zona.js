// La hora del negocio. Todo el bot trabaja en hora local (`core/fechas.js`): "hoy", los horarios libres y la anticipación
// mínima salen de `new Date()`. Un Node sin zona (el que corre adentro de la app de Android no tiene /etc/localtime ni TZ)
// arranca en UTC: para el bot eran 3 horas más tarde que en Argentina y, con la anticipación mínima, nunca ofrecía turnos
// para hoy (El dueño, 2026-10-13: "todos los días no me dejaba sacar turnos para el día que se está hablando con el bot").
//
// La app ya le pasa la zona del celular (TZ, `ServicioBot.kt`); esto es la red para una versión de la app que no la pase.
// Node toma un cambio de process.env.TZ en caliente, pero por las dudas se llama antes de crear cualquier fecha.

const ZONA_POR_DEFECTO = 'America/Argentina/Buenos_Aires'; // los negocios de Nodo Sur son de Argentina

function asegurarZona(env = process.env) {
  if (env.TZ) return env.TZ;
  const actual = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (actual && actual !== 'UTC' && !actual.startsWith('Etc/')) return actual;
  env.TZ = ZONA_POR_DEFECTO;
  return env.TZ;
}

module.exports = { asegurarZona, ZONA_POR_DEFECTO };
