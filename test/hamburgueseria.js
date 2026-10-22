// La hamburguesería (ejemplos/burger-demo.json): el saludo de alguien del local, solo envío con un precio fijo, al cerrar el
// pedido ofrece papas o algo para tomar si no lleva (una sola vez), y las charlas de verdad que tiene que entender a la primera
// (aclaraciones, sacar algo, elegir por el nombre, la dirección en el mismo mensaje).
process.env.TZ = 'America/Argentina/Buenos_Aires';
const os = require('os');
const path = require('path');

const RUTA_DB = path.join(os.tmpdir(), `test_hamburgueseria_${Date.now()}.db`);
process.env.RUTA_DB = RUTA_DB;

const { armar, ejemplo, validar } = require('../src/config');
const burger = require('../ejemplos/burger-demo.json');
const SIEMPRE = { lunes: null, martes: null, miercoles: null, jueves: null, viernes: null, sabado: null, domingo: null };
const config = armar(ejemplo(), { ...burger, servicios: [] });
const db = require('../src/db');
db.abrir(RUTA_DB);
const { crearMotor } = require('../src/core/motor');
const catalogo = require('../src/core/catalogo');
const gastro = require('../src/core/gastro');
const qPedidos = require('../src/db/consultas/pedidos');

let fallas = 0;
function chequear(nombre, cond) {
  if (cond) console.log(`  ✔ ${nombre}`);
  else { console.log(`  ✘ FALLÓ: ${nombre}`); fallas++; }
}

console.log('\n— 1. La configuración —');
chequear('pasa la validación', validar(config).length === 0);
chequear('es un local gastronómico con 🍔', gastro.esGastro(config) && config.textos.emoji === '🍔');
chequear('solo envío', gastro.formas(config).map((f) => f.clave).join() === 'CADETE');
chequear('sin alias todavía: al recibir o Mercado Pago', gastro.pagos(config).join() === 'al_entregar,mp');
chequear('ofrece extras de fábrica', gastro.ofreceExtras(config) && !gastro.ofreceExtras({ negocio: { rubro: 'rotiseria' } }));
chequear('y se puede apagar', !gastro.ofreceExtras({ negocio: { rubro: 'hamburgueseria', ofrecer_extras: false } }));

const CARTA = [
  { gid: 'b-clasica', nombre: 'Burger Clásica', precioCentavos: 900000, hay: true },
  { gid: 'b-combo', nombre: 'Combo Clásica con papas y bebida', precioCentavos: 1300000, hay: true },
  { gid: 'b-papas', nombre: 'Papas fritas', precioCentavos: 300000, hay: true },
  { gid: 'b-papasc', nombre: 'Papas con cheddar', precioCentavos: 450000, hay: true },
  { gid: 'b-coca', nombre: 'Coca Cola 500 ml', precioCentavos: 250000, hay: true },
  { gid: 'b-agua', nombre: 'Agua sin gas 500 ml', precioCentavos: 180000, hay: false },
];
catalogo.fijar(CARTA);

console.log('\n— 2. Qué ofrece —');
const nombres = (xs) => xs.map((x) => x.gid).join();
chequear('una burger sola: papas y coca (lo más barato que hay)', nombres(gastro.extrasQueFaltan([CARTA[0]], CARTA)) === 'b-papas,b-coca');
chequear('con papas: solo la bebida', nombres(gastro.extrasQueFaltan([CARTA[0], CARTA[3]], CARTA)) === 'b-coca');
chequear('un combo con papas y bebida: nada', gastro.extrasQueFaltan([CARTA[1]], CARTA).length === 0);

config.horarios = SIEMPRE; // así la hora no depende de cuándo corre el test
const motor = crearMotor(config);
const decir = (de, texto) => motor.procesarMensaje({ de, texto });
const textoPara = (salientes, quien) => salientes.filter((s) => s.para === quien).map((s) => s.texto).join('\n');

(async () => {
  console.log('\n— 3. La charla —');
  const C1 = '5492944300001';
  let r = await decir(C1, 'hola');
  chequear('saluda como alguien del local', textoPara(r, C1).includes('¿Cómo andás?') && textoPara(r, C1).includes('*Burger DEMO* 🍔'));
  r = await decir(C1, '¿hacen envíos?');
  chequear('el envío con un solo precio', textoPara(r, C1).includes('El envío sale $2.500'));
  await decir(C1, 'pedido');
  await decir(C1, '2 burger clasica');
  r = await decir(C1, 'listo');
  chequear('al cerrar ofrece papas y coca', textoPara(r, C1).includes('¿Le sumamos algo?') && textoPara(r, C1).includes('*1* — Papas fritas — $3.000')
    && textoPara(r, C1).includes('*2* — Coca Cola 500 ml') && textoPara(r, C1).includes('*3* — Las dos'));
  r = await decir(C1, 'unas papas');
  chequear('"unas papas" suma las papas y pide la dirección (no pregunta retiro)', textoPara(r, C1).includes('1 × Papas fritas') && textoPara(r, C1).includes('¿A qué dirección'));
  await decir(C1, 'Mitre 100');
  r = await decir(C1, 'Caro');
  chequear('pregunta cómo paga', textoPara(r, C1).includes('Pago al recibir') && textoPara(r, C1).includes('Mercado Pago'));
  r = await decir(C1, '1');
  const res = textoPara(r, C1);
  chequear('resumen: envío sin zona y total con papas y envío', res.includes('Envío a Mitre 100 — $2.500') && res.includes('Total: $23.500'));
  r = await decir(C1, '2');
  r = await decir(C1, 'listo');
  chequear('agregando algo después no lo vuelve a ofrecer', !textoPara(r, C1).includes('¿Le sumamos algo?'));
  await decir(C1, '1');
  const p = qPedidos.porEnviar().pop();
  chequear('el pedido va con las papas', p.datos.items.some((x) => x.gid === 'b-papas') && p.datos.entrega.forma === 'CADETE');

  const C2 = '5492944300002';
  await decir(C2, 'quiero 1 burger clasica');
  await decir(C2, 'listo');
  r = await decir(C2, 'no, así está bien');
  chequear('"no" sigue sin sumar nada', textoPara(r, C2).includes('¿A qué dirección') && !textoPara(r, C2).includes('Papas fritas'));

  const C3 = '5492944300003';
  await decir(C3, 'quiero 1 combo clasica');
  r = await decir(C3, 'listo');
  chequear('con un combo completo no ofrece nada', !textoPara(r, C3).includes('¿Le sumamos algo?') && textoPara(r, C3).includes('¿A qué dirección'));

  const C4 = '5492944300004';
  await decir(C4, 'quiero 1 burger clasica');
  await decir(C4, 'listo');
  r = await decir(C4, '3');
  chequear('"las dos" suma papas y coca', textoPara(r, C4).includes('Papas fritas') && textoPara(r, C4).includes('Coca Cola'));

  console.log('\n— 4. Que entienda a la primera —');
  catalogo.fijar([
    { gid: 'clasica', nombre: 'Hamburguesa Clásica', precioCentavos: 900000, hay: true },
    { gid: 'cheese', nombre: 'Cheeseburger Doble', precioCentavos: 1100000, hay: true },
    { gid: 'baconS', nombre: 'Bacon Cheese Simple', precioCentavos: 1050000, hay: true },
    { gid: 'baconD', nombre: 'Bacon Cheese Doble', precioCentavos: 1300000, hay: true },
    { gid: 'veggie', nombre: 'Veggie Burger', precioCentavos: 950000, hay: true },
    { gid: 'combo1', nombre: 'Combo Clásica con papas y bebida', precioCentavos: 1300000, hay: true },
    { gid: 'papas', nombre: 'Papas fritas', precioCentavos: 300000, hay: true },
    { gid: 'papasch', nombre: 'Papas con cheddar y bacon', precioCentavos: 480000, hay: true },
    { gid: 'coca', nombre: 'Coca Cola 500 ml', precioCentavos: 250000, hay: true },
    { gid: 'cocaz', nombre: 'Coca Cola Zero 500 ml', precioCentavos: 250000, hay: true },
    { gid: 'sprite', nombre: 'Sprite 500 ml', precioCentavos: 250000, hay: true },
    { gid: 'agua', nombre: 'Agua sin gas 500 ml', precioCentavos: 180000, hay: true },
  ]);
  let n = 10;
  const nuevo = () => `54929443000${n++}`;
  const charla = async (tel, ...textos) => { let r; for (const t of textos) r = await decir(tel, t); return textoPara(r, tel); };

  let t = await charla(nuevo(), 'buenass');
  chequear('"buenass" es un saludo, no un gracias', t.includes('¿Cómo andás?'));
  const P = nuevo();
  t = await charla(P, '¿aceptan mercado pago?');
  chequear('cómo se paga lo contesta el bot (no lo pasa al local)', t.includes('Podés pagar al recibir (efectivo) o con Mercado Pago'));
  t = await charla(P, '¿cuánto tarda?');
  chequear('"¿cuánto tarda?": abierto y en cuánto llega', t.includes('Estamos abiertos') && t.includes('llega en unos'));
  t = await charla(P, '¿puedo pasar a buscarlo?');
  chequear('solo envío: lo dice', t.includes('Por ahora solo hacemos envíos'));
  t = await charla(P, '¿qué hamburguesas tienen?');
  chequear('"¿qué hamburguesas tienen?" lista todas las burgers', t.includes('Cheeseburger Doble') && t.includes('Bacon Cheese Simple') && !t.includes('Papas') && !t.includes('Combo'));
  t = await charla(P, '¿tienen opción vegetariana?');
  chequear('"vegetariana" es la veggie', t.includes('Veggie Burger'));

  t = await charla(nuevo(), 'hola quiero 2 hamburguesas clasicas y una coca');
  chequear('"clásica" es la burger (no el combo) y "coca" la común (no la zero)', t.includes('2 × Hamburguesa Clásica') && t.includes('1 × Coca Cola 500 ml') && !t.includes('¿Cuál'));
  t = await charla(nuevo(), 'kiero una amburguesa clasica');
  chequear('con errores de tipeo igual la anota', t.includes('1 × Hamburguesa Clásica'));
  t = await charla(nuevo(), 'quiero 2 papas fritas');
  chequear('"papas fritas" son las fritas, no las de cheddar', t.includes('2 × Papas fritas') && !t.includes('¿Cuál'));

  const L = nuevo();
  t = await charla(L, 'Hola buenas noches! queria pedir 2 combos clasicos, uno sin tomate, y 2 sprite. para Belgrano 250');
  chequear('mensaje largo: anota todo y la aclaración', t.includes('2 × Combo Clásica') && t.includes('de esos, 1 sin tomate') && t.includes('2 × Sprite'));
  t = await charla(L, 'listo');
  chequear('con combos no ofrece extras, y la dirección del mensaje ya está', !t.includes('¿Le sumamos') && t.includes('¿A nombre de quién'));
  t = await charla(L, 'soy Sofi', '1');
  chequear('resumen con la aclaración y la dirección', t.includes('Sofi, así quedó') && t.includes('(sin tomate)') && t.includes('Envío a Belgrano 250'));
  await charla(L, 'esta perfecto gracias');
  const pl = qPedidos.porEnviar().pop();
  chequear('"está perfecto, gracias" confirma, y la aclaración va en la nota del pedido', pl.datos.cliente.nombre === 'Sofi'
    && pl.datos.nota === '1 × Combo Clásica con papas y bebida: sin tomate' && pl.datos.entrega.direccion === 'Belgrano 250');

  const S = nuevo();
  await charla(S, 'quiero 2 clasicas y una coca');
  t = await charla(S, 'sin cebolla');
  chequear('"sin cebolla" suelto va a la burger, no a la coca', t.includes('2 × Hamburguesa Clásica (sin cebolla)'));
  t = await charla(S, 'sacame la coca');
  chequear('"sacame la coca" la saca', t.includes('saqué 1 × Coca Cola'));
  t = await charla(S, 'sacame la sprite');
  chequear('lo que no está en el pedido lo dice', t.includes('No tenés la sprite en el pedido'));

  const E = nuevo();
  t = await charla(E, 'pedido', 'una bacon');
  chequear('"una bacon" pregunta cuál', t.includes('¿Cuál de estos?'));
  t = await charla(E, 'y una coca zero');
  chequear('otro producto mientras elige: lo anota y vuelve a preguntar', t.includes('1 × Coca Cola Zero') && t.includes('¿Cuál de estos querés?'));
  t = await charla(E, 'listo');
  chequear('"listo" sin elegir: le recuerda qué falta', t.includes('Antes de cerrar me falta una cosa'));
  t = await charla(E, 'la simple');
  chequear('elige por el nombre', t.includes('Bacon Cheese Simple'));
  t = await charla(E, 'listo');
  chequear('ofrece papas (ya tiene bebida)', t.includes('Papas fritas') && !t.includes('Coca Cola 500'));
  t = await charla(E, 'Mitre 100');
  chequear('si sigue de largo con la dirección, es un no y la toma', t.includes('¿A nombre de quién') && !t.includes('no te estoy entendiendo'));

  const X = nuevo();
  t = await charla(X, 'una veggie', 'listo', 'si');
  chequear('"sí" con dos para sumar: pregunta cuál, sin pasarlo a una persona', t.includes('¿Qué te sumo?'));
  t = await charla(X, 'las dos');
  chequear('y "las dos" suma las dos', t.includes('Papas fritas') && t.includes('Coca Cola 500 ml'));
  t = await charla(X, 'Mitre 5', 'Eva', '1', 'sumale una sprite');
  chequear('en el resumen, "sumale una sprite" la suma y vuelve a mostrarlo', t.includes('1 × Sprite') && t.includes('Eva, así quedó'));

  console.log('\n— 5. Con el contexto del mensaje anterior —');
  t = await charla(nuevo(), '¿tienen veggie?', 'dale, quiero una');
  chequear('"¿tienen veggie?" → "dale, quiero una" la anota', t.includes('1 × Veggie Burger'));
  t = await charla(nuevo(), '¿cuánto sale la bacon simple?', 'pasame 2');
  chequear('"pasame 2" después del precio: 2 de esa', t.includes('2 × Bacon Cheese Simple'));
  const D = nuevo();
  t = await charla(D, '¿cuánto sale la bacon simple?', '¿y la doble?');
  chequear('"¿y la doble?" es la bacon doble (no cualquier doble)', t.includes('Bacon Cheese Doble') && !t.includes('Cheeseburger'));
  t = await charla(D, 'dame esa');
  chequear('"dame esa" con la burger y su combo a la vista: la burger', t.includes('1 × Bacon Cheese Doble') && !t.includes('¿Cuál'));
  t = await charla(nuevo(), '¿qué hamburguesas tienen?', 'la segunda');
  chequear('"la segunda" de la lista', t.includes('1 × Cheeseburger Doble'));
  t = await charla(nuevo(), '¿cuánto sale la cheeseburger?', 'quiero esa');
  chequear('"quiero esa"', t.includes('1 × Cheeseburger Doble'));
  const V = nuevo();
  t = await charla(V, '¿tienen veggie?', '¿cuánto sale?');
  chequear('"¿cuánto sale?" sin decir qué: lo que acaba de ver', t.includes('Veggie Burger — $9.500'));
  t = await charla(nuevo(), '¿tienen veggie?', 'ok gracias');
  chequear('"ok gracias" después de un precio no es un pedido', t.includes('Gracias a vos') && !t.includes('Veggie'));
  const O = nuevo();
  await charla(O, 'quiero una clasica');
  t = await charla(O, 'otra más');
  chequear('"otra más" suma una de lo último', t.includes('2 × Hamburguesa Clásica'));
  t = await charla(O, 'que sean 3');
  chequear('"que sean 3" cambia la cantidad', t.includes('3 × Hamburguesa Clásica'));
  t = await charla(O, 'y una coca', 'otra');
  chequear('"otra" después de la coca suma una coca', t.includes('2 × Coca Cola 500 ml'));

  console.log(fallas ? `\n❌ ${fallas} chequeos de hamburguesería fallaron` : '\n✅ Hamburguesería OK');
  process.exit(fallas ? 1 : 0);
})();
