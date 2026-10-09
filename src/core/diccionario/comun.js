// Lo que el bot entiende en cualquier rubro: intenciones (cambiar, cancelar, confirmar, llegar tarde, pedir una persona,
// reservar, saludar), cierres de cortesía, volver al menú y los temas que se preguntan en todos lados (cómo se paga,
// si hacen envíos, si están abiertos). Lo de cada rubro (servicios, productos) está en `rubros.js`.
//
// Todas las claves van escritas como quedan después de `nlu.normalizar`: sin tildes, en minúsculas y con lo de chat ya
// expandido ("q" → "que"). Una frase se busca como palabras enteras; una palabra suelta de 5 letras o más acepta un error
// de tipeo; una expresión regular, para lo que una lista no alcanza ("llego 10 min tarde").
//
// Cada frase nueva tiene que pasar por test/frases.js: ahí se ve si arregla una cosa sin romper otra.

// El ORDEN importa: gana la primera que calza. "no puedo ir el viernes, me lo pasás para el sábado" tiene "no puedo ir"
// (cancelar) y "me lo pasás" (cambiar): va primero cambiar. "no quiero cancelar" va antes que cancelar.
const INTENCIONES = [
  ['confirmar', [/\bno (?:quiero |voy a |vamos a |pienso |hace falta )?(?:cancelar|cancelo|cancelarlo|cancelarla|anular)\b/]],
  ['reprogramar', [
    'cambiar el turno', 'cambiar mi turno', 'cambiar turno', 'cambiarlo', 'cambiarla', 'cambiar el horario', 'cambiar la hora',
    'cambiar el dia', 'cambio de turno', 'cambio de horario', 'cambio de dia', 'mover el turno', 'moverlo', 'moverla',
    'pasar el turno', 'pasarlo', 'pasarla', 'correr el turno', 'correrlo', 'correrla', 'reprogramar', 'reprogramarlo',
    'reprogramarla', 'postergar', 'posponer', 'adelantar el turno', 'atrasar el turno', 'otro horario', 'otra hora', 'para otro dia',
    'en vez de', 'mejor el', 'mejor a las', 'mejor para',
    /\b(?:me lo|me la|lo|la|el turno) (?:pasas|pasan|podes pasar|pueden pasar|cambias|cambian|podes cambiar|pueden cambiar|moves|corres|corren|adelantas|atrasas)\b/,
    /\bpuedo (?:ir )?(?:a las|el|para el|mas tarde|mas temprano|otro)\b/,
  ]],
  ['demora', [
    /\b(?:llego|llegamos|voy|vamos|estoy|estamos|salgo|sali)\b(?: \w+){0,4} tarde\b/,
    /\b(?:demorad[oa]s?|atrasad[oa]s?|me demor[eo]|me atras[eo]|me retras[eo]|nos demoramos|estoy llegando|ya llego|llego en|en camino|estoy yendo|ya salgo|ya sali)\b/,
  ]],
  ['cancelar', [
    'cancelar', 'cancela', 'cancelo', 'cancelame', 'cancelalo', 'cancelala', 'cancelas', 'anular', 'anulalo', 'suspender',
    'dar de baja', 'no voy', 'no llego', 'no puedo ir', 'no voy a poder', 'no vamos a poder', 'no podre', 'al final no',
    'surgio algo', 'me surgio algo', 'tuve un problema',
  ]],
  ['confirmar', [
    'confirmo', 'confirmar', 'confirmado', 'confirmada', 'ahi estoy', 'ahi estare', 'ahi voy', 'ahi voy a estar', 'ahi estamos',
    'si voy', 'voy a ir', 'nos vemos manana', 'cuenten conmigo', 'sin falta', 'voy sin falta', 'confirmo asistencia',
  ]],
  // "alguien" suelto NO: "¿alguien me dice el precio?" es una pregunta, no un pedido de persona.
  ['humano', [
    'humano', 'humana', 'una persona', 'persona real', 'alguien real', 'hablar con', 'atiende alguien', 'me atiende alguien',
    'alguien me atiende', 'alguien que me atienda', 'alguien que me responda', 'alguien me puede atender', 'hay alguien',
    'me pueden llamar', 'me podes llamar', 'llamame', 'llamenme', 'me llamas', 'sos un bot', 'sos bot', 'sos un robot',
    'es un bot', 'es un robot', 'sos una maquina', 'contestador', 'operador', 'operadora', 'encargada', 'encargado', 'duena',
    'dueno', 'no es lo que pregunte', 'no me entendes', 'no me entendiste', 'no me entiende', 'no entendes', 'no entendiste',
    'urgente', 'reclamo', 'queja', 'me quiero quejar',
  ]],
  ['reservar', [
    'turno', 'turnos', 'turnito', 'reservar', 'reserva', 'reservame', 'agendar', 'agendame', 'anotame', 'cita', 'sacar turno',
    'sacar un turno', 'pedir turno', 'pedir hora', 'tenes lugar', 'tienen lugar', 'hay lugar', 'lugarcito', 'tenes algo',
    'tienen algo', 'hay algo', 'hueco', 'disponibilidad', 'disponible', 'cuando podes', 'cuando pueden', 'me atendes',
    'me atienden', 'me haces', 'me podes hacer', 'me pueden hacer', 'hacerme', 'quiero hacerme', 'me quiero hacer',
  ]],
  ['saludo', [
    'hola', 'holis', 'buenas', 'buen dia', 'buenos dias', 'buenas tardes', 'buenas noches', 'que tal', 'como estas',
    'como andas', 'como va', 'como estan', 'que onda', 'hey', 'ey', 'todo bien',
  ]],
];

// "menú", "volver", "empezar de nuevo": vuelven al principio desde cualquier paso.
const VOLVER_AL_MENU = [
  'menu', 'inicio', 'volver', 'volver al menu', 'volver al inicio', 'volver al principio', 'ir al menu', 'menu principal',
  'empezar de nuevo', 'empezar de cero', 'arrancar de nuevo', 'de nuevo', 'atras', 'salir', 'principio', 'ver menu',
  'ver el menu', 'opciones', 'ver opciones',
];

// Cortesía: un mensaje hecho SOLO de estas palabras ("gracias genia!", "dale mil gracias", "ok perfecto") no pide nada.
// Tiene que haber al menos una de las PRINCIPALES ("de" o "che" solos no son un gracias).
const CORTESIA_PRINCIPALES = new Set([
  'gracias', 'genial', 'perfecto', 'perfecta', 'dale', 'listo', 'lista', 'buenisimo', 'buenisima', 'ok', 'oka', 'okey', 'okis',
  'joya', 'barbaro', 'besos', 'beso', 'abrazo', 'saludos', 'igualmente', 'excelente', 'bueno', 'buena', 'genio', 'genia',
  'capo', 'capa', 'crack', 'divina', 'divino', 'hermosa', 'tranqui', 'impecable', 'espectacular', 'nada', 'vemos', 'chau',
  'chao', 'bendiciones', 'problema', 'preocupes', 'sisi', 'entendido', 'entiendo', 'claro', 'perfect', 'thanks',
]);
const CORTESIA_RELLENO = new Set([
  'mil', 'muchas', 'muchisimas', 'de', 'nos', 'un', 'una', 'che', 're', 'muy', 'bien', 'ahi', 'que', 'amiga', 'amigo',
  'linda', 'lindo', 'idola', 'idolo', 'reina', 'rey', 'te', 'les', 'por', 'todo', 'gente', 'a', 'vos', 'ustedes', 'y',
  'dios', 'buen', 'dia', 'finde', 'semana', 'tarde', 'noche', 'muchachos', 'chicas', 'chicos', 'mi', 'si', 'no', 'problema',
  'hay',
]);
const EMOJIS_CORTESIA = /^[\s👍👌🙌🙏❤🧡💛💚💙💜🖤🤍💖💕💗😊☺🥰😘😍🤗✨🌸🌺💅💈✂🔥💪🫶👏😁😀🙂]+$/u;

// Temas que se preguntan en cualquier negocio. La respuesta sale de config.respuestas[tema]; si el negocio no la cargó,
// el bot le pasa la pregunta a una persona (salvo envíos en un comercio: los pedidos son para retirar, ver comercio.js).
const TEMAS = {
  pagos: [
    'mercado pago', 'mercadopago', 'mp', 'tarjeta', 'tarjetas', 'debito', 'credito', 'efectivo', 'transferencia', 'transferir',
    'transfiero', 'cbu', 'cvu', 'qr', 'formas de pago', 'forma de pago', 'medios de pago', 'medio de pago', 'como se paga',
    'como pago', 'puedo pagar', 'se puede pagar', 'pagar con', 'cuotas', 'cuenta dni', 'uala', 'modo',
  ],
  envios: [
    'envio', 'envios', 'envian', 'delivery', 'domicilio', 'a domicilio', 'me lo traen', 'me lo llevan', 'lo traen', 'lo llevan',
    'reparto', 'repartidor', 'pedidosya', 'pedidos ya', 'rappi', 'hacen entregas', 'entregan',
  ],
  horarios: [
    'abierto', 'abiertos', 'abierta', 'abiertas', 'abren', 'cierran', 'cierra', 'abre', 'estan atendiendo', 'atienden hoy',
    'hasta que hora', 'a que hora', 'horario', 'horarios', 'cuando abren', 'feriado', 'feriados',
  ],
  ubicacion: [
    'donde', 'direccion', 'ubicacion', 'como llego', 'donde queda', 'donde estan', 'en que calle', 'mapa', 'ubicados',
  ],
};

const SI = new Set(['si', 'dale', 'ok', 'oka', 'okey', 'bueno', 'obvio', 'claro', 'de una', 'quiero', 'sisi', 'si quiero',
  'reservalo', 'reservamelo', 'si porfa', 'dale porfa', 'si dale', 'por favor', 'porfa', 'joya', 'va', 'vamos']);

const NO = new Set(['no', 'nop', 'nope', 'nah', 'nono', 'no no', 'mejor no', 'dejalo', 'dejala', 'no gracias', 'para nada',
  'ni ahi', 'no quiero', 'no dale', 'no porfa', 'no por favor']);

module.exports = { INTENCIONES, VOLVER_AL_MENU, CORTESIA_PRINCIPALES, CORTESIA_RELLENO, EMOJIS_CORTESIA, TEMAS, SI, NO };
