// "NLU" casero: sin IA, puro diccionario + normalización + tolerancia a typos.
// Detecta la INTENCIÓN de un texto libre ("quiero sacar turno para mañana",
// "me lo cancelas porfa", "atiende alguien?") y también servicios por nombre
// ("quiero kapping" → arranca directo con ese servicio).

const chat = require('./diccionario/normalizar');

// Quita tildes, mayúsculas y signos, y escribe de una sola forma lo de chat ("q", "dsp", "holaaa"; ver
// diccionario/normalizar.js): "¿Cuánto sale?" → "cuanto sale", "q precio tiene??" → "que precio tiene".
function normalizar(texto) {
  return chat.expandir((texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
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

// ¿El texto contiene esta palabra/frase clave? Frases: como palabras enteras ("si voy" no está en "casi voy").
// Palabras: por token exacto, o typo de 1 letra si la palabra es larga. Una expresión regular se prueba tal cual
// (para lo que una lista no alcanza: "llego 10 min tarde").
function contiene(textoNorm, tokens, clave) {
  if (clave instanceof RegExp) return clave.test(textoNorm);
  if (clave.includes(' ')) return ` ${textoNorm} `.includes(` ${clave} `);
  return tokens.some((tok) => tok === clave || (clave.length >= 5 && distancia1(tok, clave)));
}

// Las intenciones (cambiar, cancelar, confirmar, llegar tarde, pedir una persona, reservar, saludar) están en el
// diccionario común: diccionario/comun.js. El orden de esa lista es la prioridad.
const comun = require('./diccionario/comun');
const INTENCIONES = comun.INTENCIONES;

// Las palabras del diccionario del rubro, sumadas al texto: "quiero manicura" → "quiero manicura semipermanente manos"
// (diccionario/rubros.js). Así el servicio se encuentra por su nombre, sea cual sea el que cargó el negocio.
function conSinonimos(textoNorm, sinonimos = {}) {
  const conBordes = ` ${textoNorm} `;
  const extra = Object.entries(sinonimos).filter(([k]) => conBordes.includes(` ${k} `)).map(([, v]) => v);
  return extra.length ? `${textoNorm} ${extra.join(' ')}` : textoNorm;
}

// Servicio mencionado por nombre: matchea si TODAS las palabras del nombre
// aparecen en el texto (con tolerancia a typos). "quiero soft gel" → Soft gel.
// También por sus alias (columna `alias`, separados por coma): "Fade / degradé"
// pide las dos palabras, pero en la barbería se dice "un fade" a secas.
function servicioPorNombre(texto, servicios, sinonimos) {
  const textoNorm = conSinonimos(normalizar(texto), sinonimos);
  const tokens = textoNorm.split(' ');
  let mejor = null;
  let mejorLargo = 0;
  for (const s of servicios) {
    const nombres = [s.nombre, ...String(s.alias || '').split(',')].filter((n) => n.trim());
    for (const nombre of nombres) {
      const palabras = normalizar(nombre).split(' ').filter((p) => p.length >= 3);
      if (!palabras.length) continue;
      // Ante empate ("corte + barba" contra el alias "corte"), gana el que
      // calza con más palabras: es el más específico.
      if (palabras.every((p) => contiene(textoNorm, tokens, p)) && palabras.length > mejorLargo) {
        mejor = s;
        mejorLargo = palabras.length;
      }
    }
  }
  return mejor;
}

// Palabras de un nombre de servicio que no lo distinguen de otro ("Corte clásico": "clásico" no dice qué corte).
const GENERICAS = new Set(['para', 'con', 'sin', 'mas', 'clasico', 'clasica', 'completo', 'completa', 'simple',
  'tradicional', 'servicio', 'sesion', 'comun']);

// Los servicios que el texto nombra a medias: "semi" → Semipermanente manos y pies; "barba" → Corte + barba y Perfilado
// de barba. Para preguntar cuál en vez de mostrar el menú.
function serviciosMencionados(texto, servicios, sinonimos) {
  const textoNorm = conSinonimos(normalizar(texto), sinonimos);
  const tokens = textoNorm.split(' ');
  return servicios.filter((s) => [s.nombre, ...String(s.alias || '').split(',')].some((nombre) =>
    normalizar(nombre).split(' ').some((p) => p.length >= 4 && !GENERICAS.has(p) && contiene(textoNorm, tokens, p))));
}

// Devuelve { intencion, servicio, candidatos }: el servicio si se nombró entero, los candidatos si se nombró a medias.
function interpretar(texto, servicios, sinonimos) {
  const textoNorm = normalizar(texto);
  const tokens = textoNorm.split(' ');
  let intencion = null;
  for (const [nombre, claves] of INTENCIONES) {
    if (claves.some((c) => contiene(textoNorm, tokens, c))) { intencion = nombre; break; }
  }
  const servicio = servicios ? servicioPorNombre(texto, servicios, sinonimos) : null;
  const candidatos = servicios && !servicio ? serviciosMencionados(texto, servicios, sinonimos) : [];
  return { intencion, servicio, candidatos };
}

// ---------- cortesía, menú, risas, temas ----------
// "gracias genia!", "dale mil gracias", "ok perfecto", "👍🏻": solo cortesía (diccionario/comun.js), con un error de
// tipeo en las palabras largas ("graciias").
function esCortesia(texto) {
  const crudo = chat.sinModificadores(texto).trim();
  if (!crudo) return false;
  if (comun.EMOJIS_CORTESIA.test(crudo)) return true;
  const n = normalizar(crudo);
  if (!n) return false;
  let principal = false;
  for (const t of n.split(' ')) {
    if (comun.CORTESIA_PRINCIPALES.has(t)
      || (t.length >= 5 && [...comun.CORTESIA_PRINCIPALES].some((c) => c.length >= 5 && distancia1(t, c)))) principal = true;
    else if (!comun.CORTESIA_RELLENO.has(t)) return false;
  }
  return principal;
}

const esVolverAlMenu = (texto) => comun.VOLVER_AL_MENU.includes(normalizar(texto));
const esRisa = (texto) => chat.esRisa(normalizar(texto), texto);
const esSi = (texto) => comun.SI.has(normalizar(texto));

// ¿Pregunta por un tema que se responde igual en cualquier negocio? Primero las preguntas que cargó el negocio
// (config.preguntas: [{ claves, respuesta }]); después cómo se paga, envíos, horarios y ubicación (estos dos suman las
// claves de config.faq). Devuelve { tema, respuesta? } o null.
function tema(config, texto) {
  const textoNorm = normalizar(texto);
  const tokens = textoNorm.split(' ');
  const hay = (claves) => (claves || []).some((k) => contiene(textoNorm, tokens, k instanceof RegExp ? k : normalizar(k)));
  for (const p of config.preguntas || []) {
    if (p && p.respuesta && hay(p.claves)) return { tema: 'pregunta', respuesta: p.respuesta };
  }
  if (hay(comun.TEMAS.pagos)) return { tema: 'pagos' };
  if (hay(comun.TEMAS.envios)) return { tema: 'envios' };
  if (hay([...comun.TEMAS.horarios, ...(config.faq?.horarios || [])])) return { tema: 'horarios' };
  if (hay([...comun.TEMAS.ubicacion, ...(config.faq?.ubicacion || [])])) return { tema: 'ubicacion' };
  return null;
}

// ---------- fecha y hora en texto libre ----------
// "para mañana a las 15", "el viernes 14:30", "el 14/8 a las 10", "el dia 20", "el finde", "tipo 4 y media",
// "la semana que viene a la tarde", "dsp del mediodía".
const fechas = require('./fechas');
const DIAS_SEMANA = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
const HORAS_PALABRA = { una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12 };

// Devuelve { dia, hora, horaAmbigua, franja, desde }:
//  * horaAmbigua: "a las 5" sin decir mañana o tarde (el que agenda la resuelve con el horario del negocio: 17:00);
//  * franja: 'manana' | 'mediodia' | 'tarde' | 'noche' si dijo la parte del día sin la hora;
//  * desde: 'YYYY-MM-DD' si pidió "la semana que viene" sin un día.
function extraerFechaHora(texto, ahora = new Date()) {
  let t = (texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  t = chat.expandir(t.replace(/[¿?!,;()"'¡]/g, ' ').replace(/\s+/g, ' ').trim());
  const hoy0 = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
  const aYmd = (d) => fechas.aTexto(d).slice(0, 10);
  const masDias = (n) => new Date(hoy0.getFullYear(), hoy0.getMonth(), hoy0.getDate() + n);

  // HORA primero (y la borramos del texto, así "a las 15" no se confunde con "el 15")
  let hora = null, horaAmbigua = false;
  const palabraHora = Object.keys(HORAS_PALABRA).join('|');
  const mh = t.match(/a las? (\d{1,2})(?:[:.](\d{2}))?/)
        || t.match(/\b(\d{1,2})[:.](\d{2})\b/)
        || t.match(/\b(\d{1,2})\s*(?:hs|horas)\b/)
        || t.match(/\btipo (\d{1,2})(?:[:.](\d{2}))?\b/)
        // "tipo 4 de la tarde", "5 de la tarde"
        || t.match(/\b(\d{1,2})\s*(?:de la (?:tarde|noche|manana))/)
        || t.match(new RegExp(`(?:a las?|tipo) (${palabraHora})\\b`));
  if (mh) {
    let h = HORAS_PALABRA[mh[1]] ?? parseInt(mh[1], 10);
    let min = mh[2] || '00';
    // "4 y media", "4 y cuarto", "5 menos cuarto"
    const despues = t.slice(mh.index + mh[0].length);
    if (!mh[2] && /^\s*y media\b/.test(despues)) min = '30';
    else if (!mh[2] && /^\s*y cuarto\b/.test(despues)) min = '15';
    else if (!mh[2] && /^\s*menos cuarto\b/.test(despues)) { min = '45'; h -= 1; }
    const tarde = /de la tarde|de la noche|\bpm\b/.test(t);
    const manana = /de la manana|\bam\b/.test(t);
    if (tarde && h < 12) h += 12;
    if (h >= 0 && h <= 23) {
      hora = `${String(h).padStart(2, '0')}:${min}`;
      horaAmbigua = !tarde && !manana && h >= 1 && h <= 11;
    }
    t = t.replace(mh[0], ' ').replace(/^\s*(?:y media|y cuarto|menos cuarto)\b/, ' ');
  }

  // La parte del día (sin hora): "a la tarde", "dsp del mediodía", "temprano". Se borra para que "mañana a la mañana"
  // no se lea dos veces como el día "mañana".
  let franja = null;
  const FRANJAS = [
    ['tarde', /\b(?:a la|por la|de la|en la) tarde\b|\bdespues (?:del|de) (?:mediodia|almuerzo)\b|\b(?:a )?la siesta\b/],
    ['manana', /\b(?:a la|por la|de la|en la) manana\b|\btemprano\b|\b(?:a )?primera hora\b|\bantes del mediodia\b/],
    ['mediodia', /\b(?:al|el|a eso del|tipo) mediodia\b/],
    ['noche', /\b(?:a la|por la|de la) noche\b|\b(?:a )?ultima hora\b/],
  ];
  for (const [nombre, re] of FRANJAS) {
    if (re.test(t)) { if (!hora) franja = nombre; t = t.replace(re, ' '); break; }
  }

  // "la semana que viene", "la próxima semana": desde el lunes que viene.
  const lunesQueViene = masDias(((8 - hoy0.getDay()) % 7) || 7);
  const semanaQueViene = /\b(?:la )?semana que viene\b|\b(?:la )?proxima semana\b|\bla otra semana\b/.test(t);
  t = t.replace(/\b(?:la )?semana que viene\b|\b(?:la )?proxima semana\b|\bla otra semana\b/, ' ');

  // DÍA: relativo > nombre de día (o "el finde") > dd/mm > "el 20" / "el dia 20"
  let dia = null;
  if (/\bpasado manana\b/.test(t)) dia = aYmd(masDias(2));
  else if (/\bmanana\b/.test(t)) dia = aYmd(masDias(1));
  else if (/\bhoy\b/.test(t)) dia = aYmd(hoy0);

  if (!dia) {
    const finde = /\b(?:finde|fin de semana)\b/.test(t);
    for (const [nombre, num] of Object.entries(DIAS_SEMANA)) {
      if (new RegExp(`\\b${nombre}\\b`).test(t) || (finde && nombre === 'sabado')) {
        let delta = (num - hoy0.getDay() + 7) % 7; // "el viernes" un viernes = hoy
        if (semanaQueViene && masDias(delta) < lunesQueViene) delta += 7;
        dia = aYmd(masDias(delta));
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
  const desde = !dia && semanaQueViene ? aYmd(lunesQueViene) : null;
  return { dia, hora, horaAmbigua, franja, desde };
}

// Las franjas, en horas del día: para mostrar solo los horarios de "a la tarde".
const FRANJA_HORAS = { manana: ['00:00', '12:00'], mediodia: ['11:30', '14:30'], tarde: ['12:30', '20:00'], noche: ['19:00', '23:59'] };
const enFranja = (hora, franja) => !franja || !FRANJA_HORAS[franja] || (hora >= FRANJA_HORAS[franja][0] && hora < FRANJA_HORAS[franja][1]);

module.exports = {
  interpretar, servicioPorNombre, serviciosMencionados, conSinonimos, extraerFechaHora, enFranja, normalizar, distancia1,
  contiene, esCortesia, esVolverAlMenu, esRisa, esSi, tema,
};
