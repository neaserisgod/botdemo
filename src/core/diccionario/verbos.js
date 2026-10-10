// Los verbos como se escriben acá: con el pronombre pegado ("anulámelo", "agendamelo", "posponelo"), en voseo
// ("cancelás", "tenés", "decís") y en las formas irregulares de todos los días ("tienen", "tendrán", "consiguen"). Para
// buscar en los diccionarios alcanza con el infinitivo: "anulamelo" → anular, "tenés" → tener.
//
// No conjuga de verdad: arma los infinitivos POSIBLES de una palabra ("pasas" → pasar, aunque sean pasas de uva). Por eso
// solo sirve para compararlos contra una clave que ya es un verbo (`nlu.contiene`) o contra una lista cerrada de verbos
// (`catalogo.palabrasClave`), nunca para cambiar el texto.
//
// Palabras ya normalizadas (`nlu.normalizar`: sin tildes, en minúsculas).

// Pronombres pegados al final, los más largos primero ("cancelamelo": "melo", no "lo").
const ENCLITICOS = ['melos', 'melas', 'selos', 'selas', 'noslo', 'nosla', 'telos', 'telas', 'melo', 'mela', 'selo', 'sela',
  'telo', 'tela', 'los', 'las', 'les', 'nos', 'me', 'te', 'lo', 'la', 'le', 'se'];

// Las que no salen con las reglas: el presente, el futuro y el condicional de los verbos que se usan para pedir.
const IRREGULARES = {
  tener: ['tiene', 'tienen', 'tengo', 'tenga', 'tengan', 'tendra', 'tendras', 'tendran', 'tendria', 'tendrias', 'tendrian',
    'tenia', 'tenias', 'tenian', 'tuvieran', 'tuviera'],
  poder: ['puede', 'pueden', 'puedo', 'pueda', 'puedan', 'podra', 'podras', 'podran', 'podria', 'podrias', 'podrian'],
  querer: ['quiere', 'quieren', 'quiero', 'quiera', 'quisiera', 'quisieras', 'querria', 'querrias'],
  hacer: ['hago', 'haga', 'hagan', 'hara', 'haras', 'haran', 'haria', 'harias', 'harian', 'hizo', 'hice'],
  haber: ['hay', 'habra', 'habria', 'habia'],
  conseguir: ['consigo', 'consigue', 'consigues', 'consiguen', 'consiga', 'consigan', 'conseguis'],
  traer: ['traigo', 'traiga', 'traigan', 'trajeron', 'trajo'],
  decir: ['digo', 'dice', 'dicen', 'diga', 'digan', 'dira', 'diras', 'diran'],
  venir: ['vengo', 'viene', 'vienen', 'venga', 'vengan', 'vendra', 'vendran'],
  salir: ['salgo', 'salga', 'saldra', 'saldran'],
};
const IRREGULAR = new Map(Object.entries(IRREGULARES).flatMap(([inf, formas]) => formas.map((f) => [f, inf])));

// "cancelame" → cancela, "posponelo" → pospone. Sin pronombre, la palabra tal cual.
function sinEnclitico(palabra) {
  for (const e of ENCLITICOS) {
    if (palabra.endsWith(e) && palabra.length - e.length >= 3) return palabra.slice(0, -e.length);
  }
  return palabra;
}

// Las terminaciones de las personas que se usan en un chat, y de qué infinitivo pueden venir:
//   cancela / tene / deci (imperativo de vos)  → cancelar, tener, decir
//   cancelas / tenes / decis (voseo)            → cancelar, tener, decir
//   cancelan / venden (ellos, ustedes)          → cancelar, vender
//   cancelo (yo)                                → cancelar / canceler / cancelir: solo uno va a calzar con una clave
//   cancelaran / venderan (futuro)              → cancelar, vender
function deBase(b) {
  const r = [];
  let m;
  if ((m = b.match(/^(.{2,}[aei])r(?:a|as|an|ia|ias|ian)$/))) r.push(`${m[1]}r`); // futuro y condicional regulares
  if (/[aei]$/.test(b)) r.push(`${b}r`);
  if (/e$/.test(b)) r.push(`${b.slice(0, -1)}ir`); // "escribe" → escribir
  if (/[aei]s$/.test(b)) r.push(`${b.slice(0, -1)}r`);
  if (/es$/.test(b)) r.push(`${b.slice(0, -2)}ir`);
  if (/[ae]n$/.test(b)) r.push(`${b.slice(0, -1)}r`);
  if (/en$/.test(b)) r.push(`${b.slice(0, -2)}ir`);
  if (/o$/.test(b)) r.push(...['ar', 'er', 'ir'].map((t) => `${b.slice(0, -1)}${t}`));
  return r;
}

// Los infinitivos posibles de una palabra (nunca la misma palabra: "cancelar" no está). Vacío si es muy corta para ser
// un verbo conjugado.
const cache = new Map();
function infinitivos(palabra) {
  let r = cache.get(palabra);
  if (r) return r;
  const s = new Set();
  if (palabra.length >= 3) {
    const base = sinEnclitico(palabra);
    for (const p of base === palabra ? [palabra] : [palabra, base]) {
      if (IRREGULAR.has(p)) s.add(IRREGULAR.get(p));
      for (const inf of deBase(p)) if (inf.length >= 4) s.add(inf);
    }
  }
  s.delete(palabra);
  r = [...s];
  if (cache.size < 20000) cache.set(palabra, r);
  return r;
}

const esInfinitivo = (palabra) => /^[a-zñ]{2,}(?:ar|er|ir)$/.test(palabra);

module.exports = { infinitivos, sinEnclitico, esInfinitivo };
