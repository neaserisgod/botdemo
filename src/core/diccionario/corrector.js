// Corrector cerrado: una palabra que no se encontró se corrige SOLO contra lo que existe en ese negocio (las palabras del
// catálogo o de los servicios), nunca contra un diccionario general. Un diccionario general empeoraba ("kapping" →
// camping, "pucho" → pecho, "finde" → funde; sonda del 2026-10-09).
//
// Lo de una letra (y como suena) ya lo resuelve la búsqueda de siempre (`nlu.contiene`, `catalogo.buscar`). Esto es lo que
// queda: dos letras de diferencia en una palabra larga ("desorante" → desodorante, "semipermante" → semipermanente) y una en una
// corta ("lece" → leche). Se usa solo cuando la búsqueda normal no encontró nada, y solo si la corrección es una sola: si
// dos palabras quedan igual de cerca, no se adivina.
const { sonido } = require('./normalizar');

// Distancia de edición con letras vecinas dadas vuelta (Damerau, versión restringida), cortando apenas pasa de `max`.
function distancia(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previa = null, anterior = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const fila = [i];
    let minimo = i;
    for (let j = 1; j <= b.length; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(anterior[j] + 1, fila[j - 1] + 1, anterior[j - 1] + costo);
      if (previa && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, previa[j - 2] + 1);
      fila.push(d);
      minimo = Math.min(minimo, d);
    }
    if (minimo > max) return max + 1;
    previa = anterior;
    anterior = fila;
  }
  return anterior[b.length];
}

// Cuánta diferencia se acepta según el largo: 4 a 6 letras, una; 7 o más, dos. Menos de `desde`, nada ("sal", "te").
const tolerancia = (palabra, desde = 4) => (palabra.length < desde ? 0 : palabra.length >= 7 ? 2 : 1);

// Arma el corrector de un vocabulario (palabras ya normalizadas). Las compara escritas y como suenan. `desde`: el largo
// mínimo de una palabra para corregirla. En los servicios va desde 7: ahí cualquier mensaje pasa por el corrector y las
// palabras cortas de charla chocan ("dame" → dama, "onda" → ondas); en el catálogo, que corrige solo cuando no encontró
// nada, alcanza con 4 ("lece" → leche).
function crearCorrector(palabras, { desde = 4 } = {}) {
  const vocab = [...new Set(palabras)].filter((p) => p.length >= 4 && !/\d/.test(p)).map((p) => ({ p, s: sonido(p) }));
  const conocidas = new Set(vocab.map((x) => x.p));

  // La palabra del vocabulario más cercana, o null si no hay ninguna a tiro o si hay dos empatadas.
  return function corregir(palabra) {
    const max = tolerancia(palabra, desde);
    if (!max || conocidas.has(palabra)) return null;
    const s = sonido(palabra);
    let mejor = null, mejorD = max + 1, empate = false;
    for (const x of vocab) {
      // Que empiece con la misma letra o el mismo sonido: los errores de tipeo casi nunca están en la primera letra, y
      // si se escribe como suena ("kerso" por queso) el sonido la iguala.
      if (x.s[0] !== s[0] && x.p[0] !== palabra[0]) continue;
      const d = Math.min(distancia(palabra, x.p, max), distancia(s, x.s, max));
      if (d < mejorD) { mejor = x.p; mejorD = d; empate = false; } else if (d === mejorD && x.p !== mejor) empate = true;
    }
    return mejorD <= max && !empate ? mejor : null;
  };
}

module.exports = { crearCorrector, distancia, tolerancia };
