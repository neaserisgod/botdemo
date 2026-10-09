// Catálogo de un comercio (forma productos): lo que publica Nodo Sur para el bot (`/api/bot/catalogo`): por producto,
// su `gid`, nombre, precio en centavos y si hay stock. Nada de costos ni cantidades. Vive en memoria; `nube/` lo baja,
// lo guarda en data/catalogo.json (para arrancar sin internet) y lo carga con `fijar`.
const nlu = require('./nlu');

let items = [];
let actualizado = null;

// Las medidas, escritas de una sola forma: "2,25 L", "2.25l" y "2.25 lts" → "2d25l"; "1 kg" y "1kg" → "1kg". Sin esto
// "coca 2.25l" no encontraba "Coca Cola 2,25 L" (normalizar parte el número en la coma o el punto).
const UNIDADES = [['l', 'l|lt|lts|litro|litros'], ['ml', 'ml|cc'], ['kg', 'kg|kgs|kilo|kilos'], ['g', 'g|gr|grs|gramos']];
const RE_MEDIDA = new RegExp(`(\\d+)(?:[.,](\\d+))?\\s*(${UNIDADES.map(([, v]) => v).join('|')})(?![a-z])`, 'gi');
function medidas(texto) {
  return String(texto || '').replace(RE_MEDIDA, (_, entero, dec, unidad) => {
    const u = UNIDADES.find(([, v]) => v.split('|').includes(unidad.toLowerCase()))[0];
    return `${entero}${dec ? `d${dec}` : ''}${u}`;
  // Y un decimal sin unidad ("coca de 1,5") igual: "1d5" es el comienzo de "1d5l".
  }).replace(/\b(\d+)[.,](\d+)\b/g, '$1d$2');
}

function fijar(nuevos, cuando = null) {
  items = (nuevos || []).map((x) => ({ ...x, _norm: nlu.normalizar(medidas(x.nombre)) }));
  actualizado = cuando;
}

const todos = () => items;
const cargado = () => items.length > 0;
const cuando = () => actualizado;

// Palabras que no dicen qué producto se busca ("¿cuánto sale la coca?" → "coca").
const VACIAS = new Set([
  'que', 'cual', 'cuanto', 'cuanta', 'cuantos', 'cuantas', 'sale', 'salen', 'cuesta', 'cuestan', 'vale', 'valen', 'precio', 'precios',
  'tienen', 'tenes', 'tiene', 'hay', 'queda', 'quedan', 'quiero', 'queria', 'quisiera', 'necesito', 'busco', 'me', 'te', 'se', 'das',
  'pasame', 'mandame', 'dame', 'por', 'favor', 'porfa', 'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'a', 'al',
  'y', 'o', 'con', 'sin', 'para', 'en', 'es', 'son', 'mas', 'hola', 'buenas', 'buen', 'dia', 'tardes', 'noches', 'stock', 'algo',
  'pedido', 'pedir', 'agregar', 'agregame', 'sumame', 'sumar', 'tambien', 'otro', 'otra', 'x',
  // Del primer chat real y la sonda del 2026-10-09: "¿a cuánto está el pan?", "¿tenés algún alfajor?", "un atado de puchos".
  'esta', 'estan', 'tendras', 'tendrian', 'tenian', 'habia', 'venden', 'vendes', 'vende', 'traen', 'trae', 'consigo',
  'conseguir', 'sabes', 'saber', 'decime', 'deci', 'podes', 'puedo', 'consulta', 'pregunta', 'aca', 'ahi', 'ustedes', 'vos',
  'che', 'gracias', 'porfa', 'bueno', 'ahora', 'hoy', 'todavia', 'aun', 'les', 'le', 'lo', 'mi', 'tu', 'su', 'algun',
  'alguno', 'alguna', 'algunos', 'algunas', 'atado', 'paquete', 'unidad', 'unidades', 'kilo', 'kilos', 'kg', 'si', 'no',
  'queda', 'quedo', 'tenes', 'tiene', 'tendran', 'hacen', 'cuantos', 'cual', 'cuales',
  'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'doce', 'par', 'docena', 'media',
  // Charla, no producto: "buen día, ¿cómo va?", "¿alguien me atiende? quiero saber si tienen leche".
  'como', 'va', 'andas', 'estas', 'onda', 'tal', 'alguien', 'atiende', 'atienden', 'hablar', 'persona', 'favor', 'holis',
]);

// Lo que identifica al producto en lo que escribió el cliente.
function palabrasClave(texto) {
  return nlu.normalizar(medidas(texto)).split(' ').filter((p) => p && !VACIAS.has(p));
}

// ¿La palabra del cliente está en el nombre? Igual, como comienzo de una palabra del nombre ("galle" → galletitas) o
// con un error de tipeo en palabras largas ("lactall" → lactal).
function calzaUna(palabra, tokens) {
  return tokens.some((t) => t === palabra
    || (palabra.length >= 3 && t.startsWith(palabra))
    || (palabra.length >= 5 && nlu.distancia1(palabra, t)));
}

// La palabra, en singular ("panes" → pan, "alfajores" → alfajor, "cocas" → coca) y sus sinónimos del rubro
// (diccionario/rubros.js: "birra" → cerveza). Alcanza con que calce una.
function formas(palabra, sinonimos) {
  const f = [palabra];
  if (palabra.length > 4 && palabra.endsWith('es')) f.push(palabra.slice(0, -2));
  if (palabra.length > 3 && palabra.endsWith('s')) f.push(palabra.slice(0, -1));
  for (const x of [...f]) f.push(...(sinonimos[x] || []));
  return f;
}
const calza = (palabra, tokens, sinonimos = {}) => formas(palabra, sinonimos).some((f) => calzaUna(f, tokens));

// Productos que calzan con TODAS las palabras clave, los que hay primero. Devuelve hasta `max` y cuántos eran.
// `sinonimos`: los del rubro (diccionario/rubros.js `productosDe`).
function buscar(texto, max = 5, sinonimos = {}) {
  const claves = palabrasClave(texto);
  if (!claves.length) return { resultados: [], total: 0, claves };
  const encontrados = items.filter((x) => {
    const tokens = x._norm.split(' ');
    return claves.every((p) => calza(p, tokens, sinonimos));
  });
  encontrados.sort((a, b) => (b.hay - a.hay) || a.nombre.length - b.nombre.length || a.nombre.localeCompare(b.nombre));
  return { resultados: encontrados.slice(0, max), total: encontrados.length, claves };
}

const porGid = (gid) => items.find((x) => x.gid === gid) || null;

// Lo que pesa una unidad, si el nombre lo dice ("Yerba Playadito 1 kg" → 1000, "Queso x 500 g" → 500). Null si se vende
// suelto ("Jamón cocido x kg": el kilo es el precio, no el paquete).
function gramosPorUnidad(producto) {
  const m = medidas(producto.nombre).toLowerCase().match(/\b(\d+)(?:d(\d+))?(kg|g)\b/);
  if (!m) return null;
  const n = Number(`${m[1]}.${m[2] || 0}`);
  return Math.round(m[3] === 'kg' ? n * 1000 : n);
}

// $3.500 / $3.500,50: los centavos solo si los hay. Los miles a mano: el Node de Termux puede venir sin los datos de
// idioma y `toLocaleString('es-AR')` daría "3,500".
function plata(centavos) {
  const pesos = Math.floor(centavos / 100), resto = centavos % 100;
  const miles = String(pesos).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `$${miles}${resto ? `,${String(resto).padStart(2, '0')}` : ''}`;
}

module.exports = { fijar, todos, cargado, cuando, buscar, porGid, palabrasClave, plata, medidas, RE_MEDIDA, gramosPorUnidad };
