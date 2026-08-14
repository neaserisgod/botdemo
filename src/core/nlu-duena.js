// Interpreta lo que escribe la dueña en lenguaje natural.
// "qué tengo hoy" → agenda del día. "aprobá la 5" → !ok 5. Etc.
// Los comandos con ! siguen andando: son el atajo para quien ya los sabe.
const nlu = require('./nlu');

// Acciones destructivas: si vienen en lenguaje natural pedimos confirmación,
// porque un "anulá el 3" mal interpretado le cancela un turno a una clienta.
const DESTRUCTIVAS = ['anular', 'rechazar'];

const CLAVES = {
  // El orden de este objeto define la prioridad al interpretar.
  anular:    ['anular', 'anula', 'anulame', 'anulá', 'borrar', 'borra', 'borrame',
              'eliminar', 'elimina', 'sacar', 'saca', 'sacame', 'dar de baja',
              'cancelar el turno', 'cancela el turno', 'cancelar turno'],
  rechazar:  ['rechazar', 'rechaza', 'rechazame', 'rechazá', 'no vale', 'no sirve',
              'es falso', 'es falsa', 'trucho', 'trucha', 'no la tomes', 'invalidar'],
  aprobar:   ['aprobar', 'aproba', 'aprobá', 'aprobame', 'aprobala', 'aprobalo',
              'esta bien', 'está bien', 'dale para adelante', 'tomala', 'tomalo',
              'aceptar', 'acepta', 'validar', 'valida', 'confirmar la seña',
              'confirma la seña', 'es correcta', 'llego bien', 'llegó bien'],
  detalle:   ['turno', 'detalle', 'detalles', 'info', 'informacion', 'datos',
              'quien es', 'quién es', 'de quien', 'de quién', 'ver el'],
  hoy:       ['hoy', 'agenda', 'dia de hoy', 'día de hoy', 'ahora', 'jornada'],
  semana:    ['semana', 'semanal', 'proximos dias', 'próximos días', 'que viene',
              'esta semana', 'la semana'],
  precio:    ['precio', 'precios', 'tarifa', 'tarifas', 'valores', 'cobro', 'cobrar',
              'sale', 'cuesta', 'lista'],
  ayuda:     ['ayuda', 'comandos', 'que puedo hacer', 'qué puedo hacer', 'opciones',
              'menu', 'menú', 'como funciona', 'cómo funciona', 'help'],
};

const SI = ['si', 'sí', 'dale', 'ok', 'oka', 'confirmo', 'sisi', 'obvio', 'claro',
            'correcto', 'exacto', 'afirmativo', 'hacelo', 'hacelo si', 'proceder'];
const NO = ['no', 'nop', 'para', 'pará', 'cancela', 'cancelar', 'mejor no',
            'dejalo', 'olvidalo', 'no importa', 'negativo'];

function esSi(texto) {
  const t = nlu.normalizar(texto);
  return SI.includes(t);
}
function esNo(texto) {
  const t = nlu.normalizar(texto);
  return NO.includes(t);
}

// Interpreta el mensaje. Devuelve { accion, id, monto, servicio, natural }.
// accion === null significa que no lo entendimos.
//   natural: true si vino en lenguaje natural (no con !) → hay que confirmar
//            las acciones destructivas.
function interpretar(texto, servicios) {
  const crudo = (texto || '').trim();

  // 1) Comandos clásicos con ! — explícitos, sin confirmación
  if (crudo.startsWith('!')) return interpretarComando(crudo);

  // 2) Lenguaje natural
  const t = nlu.normalizar(crudo);
  if (!t) return { accion: null, natural: true };
  const tokens = t.split(' ');
  const numeros = (t.match(/\d+/g) || []).map(Number);

  // ¿Nombró un servicio? ("el kapping ahora sale 30000")
  const servicio = servicios ? nlu.servicioPorNombre(crudo, servicios) : null;

  // Cambio de precio: nombre de servicio + un monto (los precios son >= 100)
  if (servicio && numeros.some((n) => n >= 100)) {
    return { accion: 'precio_set', servicio, monto: numeros.find((n) => n >= 100), natural: true };
  }

  let accion = null;
  for (const [nombre, claves] of Object.entries(CLAVES)) {
    if (claves.some((c) => nlu.contiene(t, tokens, c))) { accion = nombre; break; }
  }

  // "precios" a secas (sin monto) = ver la lista
  if (accion === 'precio') return { accion: 'precio', natural: true };

  return { accion, id: numeros[0] ?? null, servicio, natural: true };
}

function interpretarComando(crudo) {
  const [cmd, ...args] = crudo.split(/\s+/);
  const mapa = {
    '!hoy': 'hoy', '!semana': 'semana', '!turno': 'detalle',
    '!ok': 'aprobar', '!no': 'rechazar', '!anular': 'anular', '!precio': 'precio',
  };
  const accion = mapa[cmd.toLowerCase()] || null;
  if (accion === 'precio' && args.length >= 2) {
    return { accion: 'precio_set', idServicio: parseInt(args[0], 10),
             monto: parseInt(args[1], 10), natural: false };
  }
  return { accion, id: parseInt(args[0], 10) || null, natural: false };
}

module.exports = { interpretar, esSi, esNo, DESTRUCTIVAS };
