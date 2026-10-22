// La hamburguesería (ejemplos/burger-demo.json): el saludo de alguien del local, solo envío con un precio fijo, y al cerrar el
// pedido ofrece papas o algo para tomar si no lleva (una sola vez).
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

  console.log(fallas ? `\n❌ ${fallas} chequeos de hamburguesería fallaron` : '\n✅ Hamburguesería OK');
  process.exit(fallas ? 1 : 0);
})();
