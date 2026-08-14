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

// ---------- fecha y hora en texto libre ----------
// "para mañana a las 15", "el viernes 14:30", "el 14/8 a las 10", "el dia 20"
const fechas = require('./fechas');
const DIAS_SEMANA = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };

function extraerFechaHora(texto, ahora = new Date()) {
  let t = (texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const hoy0 = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  const aYmd = (d) => fechas.aTexto(d).slice(0, 10);

  // HORA primero (y la borramos del texto, así "a las 15" no se confunde con "el 15")
  let hora = null;
  const mh = t.match(/a las (\d{1,2})(?:[:.](\d{2}))?/)
        || t.match(/\b(\d{1,2})[:.](\d{2})\b/)
        || t.match(/\b(\d{1,2})\s*(?:hs|hrs)\b/)
        // "tipo 4 de la tarde", "5 de la tarde"
        || t.match(/\b(\d{1,2})\s*(?:de la (?:tarde|noche|manana))/);
  if (mh) {
    let h = parseInt(mh[1], 10);
    if (/de la tarde|de la noche|pm/.test(t) && h < 12) h += 12;
    if (h >= 0 && h <= 23) hora = `${String(h).padStart(2, '0')}:${mh[2] || '00'}`;
    t = t.replace(mh[0], ' ');
  }
  // "de la mañana/tarde/noche" ya se usó para la hora: lo borramos para que
  // "a las 9 de la MAÑANA el lunes" no se lea como el día "mañana".
  t = t.replace(/de la (?:manana|tarde|noche)/g, ' ');

  // DÍA: relativo > nombre de día > dd/mm > "el 20" / "el dia 20"
  let dia = null;
  if (/\bpasado manana\b/.test(t)) dia = aYmd(new Date(hoy0.getTime() + 2 * 86400000));
  else if (/\bmanana\b/.test(t)) dia = aYmd(new Date(hoy0.getTime() + 86400000));
  else if (/\bhoy\b/.test(t)) dia = aYmd(hoy0);

  if (!dia) {
    for (const [nombre, num] of Object.entries(DIAS_SEMANA)) {
      if (new RegExp(`\\b${nombre}\\b`).test(t)) {
        const delta = (num - hoy0.getDay() + 7) % 7; // "el viernes" un viernes = hoy
        dia = aYmd(new Date(hoy0.getTime() + delta * 86400000));
        break;
      }
    }
  }
  if (!dia) {
    const m = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
    if (m) {
      const d = new Date(ahora.getFullYear(), Number(m[2]) - 1, Number(m[1]));
      if (d >= hoy0) dia = aYmd(d);
    }
  }
  if (!dia) {
    // Solo "dia 20" explícito: "el 2" pelado es una opción de menú, no una fecha
    const m = t.match(/\bdia (\d{1,2})\b/);
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= 31) {
      let d = new Date(ahora.getFullYear(), ahora.getMonth(), Number(m[1]));
      if (d < hoy0) d = new Date(ahora.getFullYear(), ahora.getMonth() + 1, Number(m[1]));
      dia = aYmd(d);
    }
  }
  return { dia, hora };
}

module.exports = { interpretar, servicioPorNombre, extraerFechaHora, normalizar, distancia1, contiene };
