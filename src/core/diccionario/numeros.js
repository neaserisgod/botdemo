// Cantidades y pesos como se piden: "dos cocas", "un par de alfajores", "media docena de huevos", "1/4 de jamón",
// "200 gramos de queso", "medio kilo", "150 de salame". Trabaja sobre el texto del renglón tal cual lo mandó el cliente.

const PALABRAS = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, quince: 15, veinte: 20, treinta: 30,
};
const PALABRA = Object.keys(PALABRAS).join('|');

const sinTildes = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Cantidad al principio. Devuelve { cantidad, resto, como } o null. `como`: 'numero' (escrito con cifras: puede ser parte
// del nombre, "9 de oro"), 'palabra', o 'docena' (el resto puede ser un paquete de esa cantidad: "huevos x 6").
function cantidadInicial(texto) {
  const t = sinTildes(texto.trim());
  let m = t.match(/^un par de\s+(.+)$/);
  if (m) return { cantidad: 2, resto: m[1], como: 'palabra' };
  m = t.match(/^media docena(?: de)?\s+(.+)$/);
  if (m) return { cantidad: 6, resto: m[1], como: 'docena' };
  m = t.match(new RegExp(`^(?:(\\d{1,2}|${PALABRA})\\s+)?docenas?(?: de)?\\s+(.+)$`));
  if (m) return { cantidad: 12 * (m[1] ? (PALABRAS[m[1]] || Number(m[1])) : 1), resto: m[2], como: 'docena' };
  // "2 coca", "2 x coca", "2x coca" (no "7up": el número pegado a letras es parte del nombre).
  m = t.match(/^(\d{1,3})(?:\s*x\s*|\s+)(.+)$/);
  if (m) return { cantidad: Number(m[1]), resto: m[2], como: 'numero' };
  m = t.match(new RegExp(`^(${PALABRA})\\s+(.+)$`));
  if (m) return { cantidad: PALABRAS[m[1]], resto: m[2], como: 'palabra' };
  return null;
}

// Peso al principio. Devuelve { gramos, resto } o null.
function pesoInicial(texto) {
  const t = sinTildes(texto.trim());
  const kilo = '(?:kg|kgs|kilo|kilos|k)';
  const de = '(?:\\s*de)?\\s+';
  const pruebas = [
    // "kilo y medio", "1 kilo y medio", "un kilo y cuarto"
    [new RegExp(`^(?:un |1 )?${kilo} y (medio|cuarto)${de}(.+)$`), (m) => (m[1] === 'medio' ? 1500 : 1250)],
    [new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*${kilo}${de}(.+)$`), (m) => Math.round(Number(m[1].replace(',', '.')) * 1000)],
    [new RegExp(`^(${PALABRA})\\s+${kilo}${de}(.+)$`), (m) => PALABRAS[m[1]] * 1000],
    [new RegExp(`^${kilo}${de}(.+)$`), () => 1000],
    [new RegExp(`^(\\d+)\\s*(?:g|gr|grs|gramos)${de}(.+)$`), (m) => Number(m[1])],
    [new RegExp(`^(?:1/4|un cuarto|cuarto)(?:\\s*${kilo})?${de}(.+)$`), () => 250],
    [new RegExp(`^(?:3/4|tres cuartos)(?:\\s*${kilo})?${de}(.+)$`), () => 750],
    // "medio kilo de queso", "1/2 de jamón", "medio de cremoso", "medio cremoso" (no "medio litro", "media docena").
    [new RegExp(`^(?:1/2\\s*${kilo}?|medio\\s*${kilo}|medio(?!\\s*(?:litro|lt|l\\b|docena)))${de}(.+)$`), () => 500],
    [new RegExp(`^(?:1/4|un cuarto|cuarto)(?:\\s*${kilo})?\\s+(.+)$`), () => 250],
    // "150 de jamón": en un mostrador, un número de 50 para arriba seguido de "de" son gramos.
    [/^(\d{2,4})\s+de\s+(.+)$/, (m) => (Number(m[1]) >= 50 ? Number(m[1]) : null)],
  ];
  for (const [re, gramos] of pruebas) {
    const m = t.match(re);
    if (!m) continue;
    const g = gramos(m);
    if (g && g > 0 && g <= 50000) return { gramos: g, resto: m[m.length - 1] };
  }
  return null;
}

// La respuesta a "¿cuánto querés?" de un pesable: "200", "200 g", "1/4", "medio", "1 kilo", "kilo y medio". Un número
// chico suelto son kilos ("2" → 2 kg); de 50 para arriba, gramos ("200" → 200 g, como en la caja). Devuelve gramos o null.
function pesoSuelto(texto) {
  const t = sinTildes(String(texto || '').trim()).replace(/[.!?]+$/, '');
  const p = pesoInicial(`${t} de x`);
  if (p && p.resto === 'x') return p.gramos;
  const m = t.match(/^(\d+(?:[.,]\d+)?)$/);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  if (n >= 50 && n <= 50000 && Number.isInteger(n)) return n;
  if (n > 0 && n <= 20) return Math.round(n * 1000);
  return null;
}

// 250 → "250 g", 1000 → "1 kg", 1500 → "1,5 kg".
function textoPeso(gramos) {
  if (gramos < 1000) return `${gramos} g`;
  return `${String(gramos / 1000).replace('.', ',')} kg`;
}

module.exports = { PALABRAS, cantidadInicial, pesoInicial, pesoSuelto, textoPeso };
