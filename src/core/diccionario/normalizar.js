// Cómo se escribe de verdad por WhatsApp: "q", "xq", "dsp", "mñn", "holaaa", "okk", "graciass". Antes de buscar
// intenciones, servicios o productos, el texto pasa por acá y queda escrito de una sola forma. Lo usa `nlu.normalizar`,
// así que vale igual para lo que escribe el cliente y para las claves de los diccionarios.

// Abreviaturas de chat → la palabra entera. Solo palabras sueltas (no partes de otra).
const ABREVIATURAS = {
  q: 'que', k: 'que', ke: 'que', qe: 'que',
  xq: 'porque', pq: 'porque', xk: 'porque', porq: 'porque', pk: 'porque',
  x: 'por', xa: 'para', pa: 'para',
  d: 'de', dl: 'del',
  dsp: 'despues', dps: 'despues', desp: 'despues', despues: 'despues',
  tmb: 'tambien', tb: 'tambien', tmbn: 'tambien', tambn: 'tambien',
  bn: 'bien', bno: 'bueno', bueeno: 'bueno',
  mnn: 'manana', mna: 'manana', mnna: 'manana', maniana: 'manana', manan: 'manana',
  cdo: 'cuando', cnd: 'cuando', qndo: 'cuando',
  toy: 'estoy', tas: 'estas', ta: 'esta', tamos: 'estamos',
  ola: 'hola', olis: 'holis', holi: 'holis',
  xfa: 'porfa', xfavor: 'porfa', pls: 'porfa', plis: 'porfa', plz: 'porfa',
  grax: 'gracias', grasias: 'gracias', grcs: 'gracias', gracia: 'gracias', graciaas: 'gracias', grac: 'gracias',
  ntp: 'no te preocupes', np: 'no hay problema',
  hs: 'hs', hrs: 'hs', hr: 'hs',
  msj: 'mensaje', msg: 'mensaje',
  tel: 'telefono', cel: 'celular',
  sab: 'sabado', dom: 'domingo', lun: 'lunes', mier: 'miercoles', juev: 'jueves', vier: 'viernes',
};

// Letras estiradas: "holaaaa", "siii" → una sola (ninguna palabra lleva tres iguales seguidas). Y la doble al final
// ("okk", "holaa", "graciass", "buenass"), salvo las que sí terminan así de verdad (ll, rr, ee: "cree", "lee").
function desestirar(palabra) {
  return palabra
    .replace(/([a-z])\1{2,}/g, '$1')
    .replace(/([a-df-km-qs-z])\1$/, '$1');
}

// Texto ya en minúsculas y sin tildes. Cambia palabra por palabra lo de arriba.
function expandir(texto) {
  return texto.split(' ').map((p) => {
    if (!p) return p;
    if (ABREVIATURAS[p] !== undefined) return ABREVIATURAS[p]; // antes de desestirar: "mnn" (mñn) no es "mn"
    const d = /^[a-z]+$/.test(p) ? desestirar(p) : p;
    return ABREVIATURAS[d] ?? d;
  }).join(' ');
}

// Cómo SUENA una palabra, para que "kansela", "reserbar", "nesesito", "kiero" y "ola" sean "cancela", "reservar",
// "necesito", "quiero" y "hola": se escribe como se escucha. qu/k/c(a,o,u) → k; c(e,i)/z → s; v → b; ll/y → y; g(e,i) → j;
// sin h (salvo ch); sin letras dobles.
function sonido(palabra) {
  return palabra
    .replace(/ch/g, 'X')
    .replace(/h/g, '')
    .replace(/qu(?=[ei])/g, 'k').replace(/q/g, 'k')
    .replace(/c(?=[ei])/g, 's').replace(/c/g, 'k')
    .replace(/z/g, 's').replace(/v/g, 'b').replace(/w/g, 'u')
    .replace(/ll/g, 'y').replace(/g(?=[ei])/g, 'j')
    .replace(/([a-z])\1+/g, '$1')
    .replace(/X/g, 'ch');
}

// Los tonos de piel y la marca de "emoji en color": "👍🏻" es "👍".
function sinModificadores(texto) {
  return String(texto || '').replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]/gu, '');
}

// "jajaja", "jsjsjs", "jeje", "xd", "😂😂": una risa, no un pedido.
function esRisa(textoNorm, crudo) {
  const t = textoNorm.replace(/\s/g, '');
  if (t && /^(?:j+[aeiosx]+|h+[ae]+|x+d+|lol|jsj*)+j*$/.test(t)) return true;
  return !t && /^[\s😂🤣😅😆😁😄]+$/u.test(sinModificadores(crudo)) && /[😂🤣😅😆😁😄]/u.test(crudo);
}

module.exports = { expandir, desestirar, sonido, sinModificadores, esRisa, ABREVIATURAS };
