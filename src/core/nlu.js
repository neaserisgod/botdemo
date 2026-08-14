// "NLU" casero: sin IA, puro diccionario + normalización + tolerancia a typos.
// Detecta la INTENCIÓN de un texto libre ("quiero sacar turno para mañana",
// "me lo cancelas porfa", "atiende alguien?") y también servicios por nombre
// ("quiero kapping" → arranca directo con ese servicio).

// Quita tildes, mayúsculas y signos: "¿Cuánto sale?" → "cuanto sale"
function normalizar(texto) {
  return (texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Distancia de edición con salida rápida (alcanza para typos de 1 letra:
// "kaping" → "kapping", "presios" → "precios").
function distancia1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, dif = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++dif > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return dif + (a.length - i) + (b.length - j) <= 1;
}

// ¿El texto contiene esta palabra/frase clave? Frases: por substring.
// Palabras: por token exacto, o typo de 1 letra si la palabra es larga.
function contiene(textoNorm, tokens, clave) {
  if (clave.includes(' ')) return textoNorm.includes(clave);
  return tokens.some((tok) => tok === clave || (clave.length >= 5 && distancia1(tok, clave)));
}

// Diccionario de intenciones. El ORDEN importa: "quiero cancelar el turno"
// tiene que dar 'cancelar', no 'reservar' (por eso cancelar va primero).
const INTENCIONES = [
  ['cancelar',  ['cancelar', 'cancela', 'cancelo', 'cancelame', 'anular', 'suspender',
                 'no voy', 'no llego', 'no puedo ir', 'no vamos a poder']],
  ['confirmar', ['confirmo', 'confirmar', 'confirmado', 'ahi estoy', 'ahi estare',
                 'si voy', 'voy a ir', 'nos vemos manana']],
  ['humano',    ['persona', 'humano', 'alguien', 'duena', 'encargada', 'urgente',
                 'hablar con', 'atiende alguien', 'me pueden llamar', 'no es lo que pregunte']],
  ['reservar',  ['turno', 'turnos', 'reservar', 'reserva', 'agendar', 'cita',
                 'sacar turno', 'pedir hora', 'tenes lugar', 'tienen lugar', 'hay lugar',
                 'disponibilidad', 'disponible', 'cuando podes', 'cuando pueden', 'me atendes']],
  ['saludo',    ['hola', 'buenas', 'buen dia', 'buenas tardes', 'buenas noches',
                 'que tal', 'como estas', 'como andas', 'holis']],
];

// Servicio mencionado por nombre: matchea si TODAS las palabras del nombre
// aparecen en el texto (con tolerancia a typos). "quiero soft gel" → Soft gel.
function servicioPorNombre(texto, servicios) {
  const textoNorm = normalizar(texto);
  const tokens = textoNorm.split(' ');
  let mejor = null;
  for (const s of servicios) {
    const palabras = normalizar(s.nombre).split(' ').filter((p) => p.length >= 3);
    if (!palabras.length) continue;
    if (palabras.every((p) => contiene(textoNorm, tokens, p))) {
      // Ante empate ("retiro de esmaltado" vs otro), gana el nombre más largo
      if (!mejor || palabras.length > normalizar(mejor.nombre).split(' ').length) mejor = s;
    }
  }
  return mejor;
}

// Devuelve { intencion, servicio }: cualquiera puede venir null.
function interpretar(texto, servicios) {
  const textoNorm = normalizar(texto);
  const tokens = textoNorm.split(' ');
  let intencion = null;
  for (const [nombre, claves] of INTENCIONES) {
    if (claves.some((c) => contiene(textoNorm, tokens, c))) { intencion = nombre; break; }
  }
  const servicio = servicios ? servicioPorNombre(texto, servicios) : null;
  return { intencion, servicio };
}

module.exports = { interpretar, servicioPorNombre, normalizar, distancia1 };
