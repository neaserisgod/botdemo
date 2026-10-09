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
  });
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
]);

// Lo que identifica al producto en lo que escribió el cliente.
function palabrasClave(texto) {
  return nlu.normalizar(medidas(texto)).split(' ').filter((p) => p && !VACIAS.has(p));
}

// ¿La palabra del cliente está en el nombre? Igual, como comienzo de una palabra del nombre ("galle" → galletitas) o
// con un error de tipeo en palabras largas ("lactall" → lactal).
function calza(palabra, tokens) {
  return tokens.some((t) => t === palabra
    || (palabra.length >= 3 && t.startsWith(palabra))
    || (palabra.length >= 5 && nlu.distancia1(palabra, t)));
}

// Productos que calzan con TODAS las palabras clave, los que hay primero. Devuelve hasta `max` y cuántos eran.
function buscar(texto, max = 5) {
  const claves = palabrasClave(texto);
  if (!claves.length) return { resultados: [], total: 0, claves };
  const encontrados = items.filter((x) => {
    const tokens = x._norm.split(' ');
    return claves.every((p) => calza(p, tokens));
  });
  encontrados.sort((a, b) => (b.hay - a.hay) || a.nombre.length - b.nombre.length || a.nombre.localeCompare(b.nombre));
  return { resultados: encontrados.slice(0, max), total: encontrados.length, claves };
}

const porGid = (gid) => items.find((x) => x.gid === gid) || null;

// $3.500 / $3.500,50: los centavos solo si los hay. Los miles a mano: el Node de Termux puede venir sin los datos de
// idioma y `toLocaleString('es-AR')` daría "3,500".
function plata(centavos) {
  const pesos = Math.floor(centavos / 100), resto = centavos % 100;
  const miles = String(pesos).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `$${miles}${resto ? `,${String(resto).padStart(2, '0')}` : ''}`;
}

module.exports = { fijar, todos, cargado, cuando, buscar, porGid, palabrasClave, plata, medidas, RE_MEDIDA };
