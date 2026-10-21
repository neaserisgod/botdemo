// Un local gastronómico (Nodo Gastro, rubro rotisería): la carta, retiro o envío con zona, la hora según la cocina y el horario
// (fuera de hora queda programado), la cocina pausada, cómo se paga, lo que viaja a Nodo Sur y los avisos de cada paso.
// Reglas en Nodo-Sur-Pos/REGLAS-NEGOCIO.md §22; la hora es la misma que `cuandoSale` de la app.
process.env.TZ = 'America/Argentina/Buenos_Aires';
const os = require('os');
const path = require('path');

const RUTA_DB = path.join(os.tmpdir(), `test_gastro_${Date.now()}.db`);
process.env.RUTA_DB = RUTA_DB;

const { armar, ejemplo, validar } = require('../src/config');
const SIN_HORARIO = { lunes: null, martes: null, miercoles: null, jueves: null, viernes: null, sabado: null, domingo: null };
const PEDIDOS = {
  retiro: true, cadete: true, reparto: false,
  zonas: [{ nombre: 'Centro', costo: 1500, demora_min: 15 }, { nombre: 'Km 5', costo: 2500, demora_min: 25 }],
  pago: 'a_elegir', cocina: 'normal', minutos_normal: 30, minutos_demorada: 60, confirmacion_automatica: false,
  alias: 'la.rotiseria', titular: 'Juan Pérez',
};
const config = armar(ejemplo(), { negocio: { rubro: 'rotiseria', nombre: 'Lo de Juan', direccion: 'Moreno 300' }, servicios: [], pedidos: PEDIDOS });
const db = require('../src/db');
db.abrir(RUTA_DB);
db.sembrarServicios(config.servicios);
const { crearMotor } = require('../src/core/motor');
const catalogo = require('../src/core/catalogo');
const comercio = require('../src/core/comercio');
const gastro = require('../src/core/gastro');
const qPedidos = require('../src/db/consultas/pedidos');
const { crearSincronizador } = require('../src/nube/sincronizar');
const motor = crearMotor(config);

let fallas = 0;
function chequear(nombre, cond) {
  if (cond) console.log(`  ✔ ${nombre}`);
  else { console.log(`  ✘ FALLÓ: ${nombre}`); fallas++; }
}
const decir = (de, texto) => motor.procesarMensaje({ de, texto });
const textoPara = (salientes, quien) => salientes.filter((s) => s.para === quien).map((s) => s.texto).join('\n');

catalogo.fijar([
  { gid: 'g-mila', nombre: 'Milanesa con papas', precioCentavos: 650000, hay: true },
  { gid: 'g-empa', nombre: 'Empanada de carne', precioCentavos: 120000, hay: true },
  { gid: 'g-flan', nombre: 'Flan casero', precioCentavos: 300000, hay: false },
]);

console.log('\n— 1. La plantilla —');
chequear('rotisería es un comercio y pasa la validación', config.forma === 'productos' && validar(config).length === 0);
chequear('con config.pedidos es un local gastronómico', gastro.esGastro(config));

console.log('\n— 2. La hora (la misma regla que la app) —');
const conHorario = { ...config, horarios: { ...SIN_HORARIO, viernes: { desde: '19:00', hasta: '23:30' }, sabado: { desde: '19:00', hasta: '23:30' } } };
const retiro = gastro.FORMAS.RETIRO;
const cadete = gastro.FORMAS.CADETE;
const vie20 = new Date(2026, 9, 16, 20, 0); // viernes 16/10, 20:00
let s = gastro.cuandoSale(conHorario, retiro, null, vie20);
chequear('abierto: sale en los minutos de la cocina', s && !s.programado && s.hora.getHours() === 20 && s.hora.getMinutes() === 30);
s = gastro.cuandoSale(conHorario, cadete, PEDIDOS.zonas[0], vie20);
chequear('con envío suma la demora de la zona', s.hora.getHours() === 20 && s.hora.getMinutes() === 45);
s = gastro.cuandoSale({ ...conHorario, pedidos: { ...PEDIDOS, cocina: 'demorada' } }, retiro, null, vie20);
chequear('cocina demorada: los minutos de demorada', s.hora.getHours() === 21 && s.hora.getMinutes() === 0);
s = gastro.cuandoSale(conHorario, retiro, null, new Date(2026, 9, 16, 12, 0));
chequear('antes de abrir: programado para cuando abre', s.programado && s.hora.getDate() === 16 && s.hora.getHours() === 19 && s.hora.getMinutes() === 30);
s = gastro.cuandoSale(conHorario, retiro, null, new Date(2026, 9, 17, 23, 45));
chequear('después de cerrar el sábado: el viernes que viene', s.programado && s.hora.getDate() === 23 && s.hora.getHours() === 19);
chequear('cocina pausada: no sale', gastro.cuandoSale({ ...conHorario, pedidos: { ...PEDIDOS, cocina: 'pausada' } }, retiro, null, vie20) === null);
chequear('un horario sin días abiertos no frena', !gastro.cuandoSale({ ...config, horarios: SIN_HORARIO }, retiro, null, vie20).programado);
chequear('la hora se dice linda', gastro.textoHora(new Date(2026, 9, 17, 19, 30), vie20) === 'mañana a las 19:30'
  && gastro.textoHora(new Date(2026, 9, 16, 20, 30), vie20) === 'a las 20:30');

console.log('\n— 3. Formas y pagos —');
chequear('cadete y reparto juntos se ofrecen como uno', gastro.formas({ pedidos: { retiro: true, cadete: true, reparto: true, zonas: PEDIDOS.zonas } }).length === 2);
chequear('sin zonas no se ofrece envío', gastro.formas({ pedidos: { retiro: true, cadete: true } }).length === 1);
chequear('sin alias no se pide adelantado', gastro.pagos({ pedidos: { pago: 'adelantado' } }).join() === 'al_entregar');
chequear('a elegir con alias: las dos', gastro.pagos(config).join() === 'al_entregar,alias');
chequear('costo del envío en centavos', gastro.costoEnvio(cadete, PEDIDOS.zonas[1]) === 250000 && gastro.costoEnvio(retiro, PEDIDOS.zonas[1]) === 0);

// La conversación con el horario siempre abierto, así la hora no depende de cuándo corre el test.
config.horarios = SIN_HORARIO;

console.log('\n— 4. La carta —');
const C1 = '5492944200001';
let r = decir(C1, 'hola');
chequear('el menú ofrece la carta y "hacer un pedido" (sin "para retirar")', textoPara(r, C1).includes('Ver la carta 🍗') && textoPara(r, C1).includes('*2* — Hacer un pedido\n'));
r = decir(C1, '1');
chequear('la carta escrita: lo que hay, con precio', textoPara(r, C1).includes('Milanesa con papas — $6.500') && !textoPara(r, C1).includes('Flan'));
config.negocio.catalogo_whatsapp = true;
r = decir(C1, 'menu');
r = decir(C1, '1');
chequear('con catálogo de WhatsApp: el link', textoPara(r, C1).includes(`https://wa.me/c/${config.numero_actual}`));
r = decir(C1, '¿me pasás el catálogo?');
chequear('"me pasás el catálogo" manda el link', textoPara(r, C1).includes('https://wa.me/c/'));
delete config.negocio.catalogo_whatsapp;
r = decir(C1, '¿hacen envíos?');
chequear('a "hacen envíos" contesta las zonas', textoPara(r, C1).includes('te lo llevamos') && textoPara(r, C1).includes('Km 5 — $2.500'));

console.log('\n— 5. Pedido con envío y transferencia —');
const C2 = '5492944200002';
decir(C2, 'pedido');
r = decir(C2, '2 milanesas');
chequear('anota el plato', textoPara(r, C2).includes('2 × Milanesa con papas'));
r = decir(C2, 'listo');
chequear('pregunta cómo lo quiere', textoPara(r, C2).includes('¿Cómo lo querés?') && textoPara(r, C2).includes('Que me lo traigan'));
r = decir(C2, 'que me lo traigan');
chequear('pide la dirección', textoPara(r, C2).includes('¿A qué dirección'));
r = decir(C2, 'Mitre 100, timbre B');
chequear('pide la zona, con el costo', textoPara(r, C2).includes('¿En qué zona') && textoPara(r, C2).includes('Centro (envío $1.500)'));
r = decir(C2, '1');
chequear('pide el nombre', textoPara(r, C2).includes('¿A nombre de quién'));
r = decir(C2, 'Caro');
chequear('pregunta cómo paga', textoPara(r, C2).includes('¿Cómo pagás?') && textoPara(r, C2).includes('Transfiero ahora'));
r = decir(C2, '2');
const res = textoPara(r, C2);
chequear('resumen: envío, total con envío, hora y pago', res.includes('Envío a Mitre 100, timbre B (Centro) — $1.500') && res.includes('Total: $14.500') && res.includes('Llega a las') && res.includes('transferencia'));
chequear('sin "precios de hoy" (el precio dicho es el que vale)', !res.includes('Precios de hoy'));
r = decir(C2, '1');
chequear('al confirmar le pasa el alias y el total', textoPara(r, C2).includes('alias *la.rotiseria*') && textoPara(r, C2).includes('$14.500') && textoPara(r, C2).includes('Juan Pérez'));
const p2 = qPedidos.porEnviar().pop();
chequear('el pedido lleva entrega, pago y hora', p2.datos.entrega.forma === 'CADETE' && p2.datos.entrega.zona === 'Centro'
  && p2.datos.entrega.costoEnvioCentavos === 150000 && p2.datos.pago === 'alias' && Number.isSafeInteger(p2.datos.horaEstimada) && !p2.datos.programado);

console.log('\n— 6. Retiro y pago al recibir —');
const C3 = '5492944200003';
decir(C3, 'hola, quiero 6 empanadas de carne');
r = decir(C3, 'listo');
r = decir(C3, 'paso a retirarlo');
chequear('retiro: no pide dirección', textoPara(r, C3).includes('¿A nombre de quién'));
decir(C3, 'Leo');
r = decir(C3, 'efectivo');
chequear('resumen de retiro', textoPara(r, C3).includes('Lo retirás en el local') && textoPara(r, C3).includes('Está listo a las') && textoPara(r, C3).includes('Pagás al recibir'));
decir(C3, '1');
const p3 = qPedidos.porEnviar().pop();
chequear('va como retiro sin dirección', p3.datos.entrega.forma === 'RETIRO' && !p3.datos.entrega.direccion && p3.datos.pago === 'al_entregar');

console.log('\n— 7. Cocina pausada —');
const C4 = '5492944200004';
config.pedidos.cocina = 'pausada';
r = decir(C4, 'pedido');
chequear('no toma el pedido y lo dice', textoPara(r, C4).includes('la cocina no está tomando pedidos'));
config.pedidos.cocina = 'normal';
decir(C4, 'pedido');
decir(C4, '1 mila');
decir(C4, 'listo');
decir(C4, '1');
decir(C4, 'Ana');
decir(C4, '1');
config.pedidos.cocina = 'pausada';
const antes = qPedidos.porEnviar().length;
r = decir(C4, '1');
chequear('si se pausa antes de confirmar, tampoco', textoPara(r, C4).includes('la cocina no está tomando pedidos') && qPedidos.porEnviar().length === antes);
config.pedidos.cocina = 'normal';

console.log('\n— 8. Viaja a Nodo Sur y los avisos de cada paso —');
(async () => {
  const mandados = [];
  let remotos = [];
  const enviados = [];
  const cuentaFalsa = { datos: {}, leer() { return this.datos; }, actualizar(x) { Object.assign(this.datos, x); } };
  let proximo = 100;
  const sinc = crearSincronizador({
    config,
    cliente: {
      mandarPedido: async (p) => { mandados.push(p); return { id: proximo++ }; },
      pedidos: async () => ({ pedidos: remotos, hasta: 1, mas: false }),
    },
    cuenta: cuentaFalsa,
    recargarConfig: () => [],
    enviar: async (x) => { enviados.push(...x); return x; },
    log: { log: () => {}, error: () => {} },
  });
  await sinc.mandarBandeja();
  const m2 = mandados.find((x) => x.id === p2.pedido_id);
  chequear('al sitio va la entrega, el pago y la hora', m2 && m2.entrega.forma === 'CADETE' && m2.entrega.direccion === 'Mitre 100, timbre B' && m2.pago === 'alias' && m2.horaEstimada === p2.datos.horaEstimada);
  const remoto2 = qPedidos.porId(p2.id).remoto_id;
  const remoto3 = qPedidos.porId(p3.id).remoto_id;
  const avisos = async (estados) => {
    remotos = estados.map(([id, estado]) => ({ id, estado }));
    enviados.length = 0;
    await sinc.revisarPedidos();
    return enviados.map((x) => `${x.para}:${x.texto}`).join('\n');
  };
  let t = await avisos([[remoto2, 'aceptado'], [remoto3, 'aceptado']]);
  chequear('aceptado: "te aviso cuando esté en camino" al de envío y "listo" al de retiro', t.includes(`${C2}:✅ ¡Confirmamos tu pedido! Te aviso por acá cuando esté en camino`) && t.includes(`${C3}:✅ ¡Confirmamos tu pedido! Te aviso por acá cuando esté listo`));
  t = await avisos([[remoto2, 'listo'], [remoto3, 'listo']]);
  chequear('listo: solo al de retiro', !t.includes(C2) && t.includes(`${C3}:🍽️ ¡Tu pedido está listo!`) && t.includes('Moreno 300'));
  t = await avisos([[remoto2, 'en_camino']]);
  chequear('en camino: al de envío', t.includes(`${C2}:🛵 ¡Tu pedido salió!`));
  t = await avisos([[remoto2, 'en_camino']]);
  chequear('el mismo aviso dos veces no se repite', t === '');
  t = await avisos([[remoto2, 'entregado'], [remoto3, 'cancelado']]);
  chequear('entregado no se avisa; cancelado sí', !t.includes(C2) && t.includes(`${C3}:😕 Tu pedido quedó cancelado`));
  t = await avisos([[remoto2, 'listo']]);
  chequear('no vuelve para atrás', t === '' && qPedidos.porId(p2.id).estado === 'entregado');

  console.log('\n— 9. Pago por Mercado Pago —');
  chequear('sin Mercado Pago conectado no se ofrece', !gastro.pagos(config).includes('mp'));
  config.pedidos.mp = true;
  chequear('con Mercado Pago: al recibir, Mercado Pago y alias', gastro.pagos(config).join() === 'al_entregar,mp,alias');
  const pedirConMp = (tel) => {
    decir(tel, 'pedido');
    decir(tel, '1 mila');
    decir(tel, 'listo');
    decir(tel, '1');
    decir(tel, `Cliente ${tel.slice(-2)}`);
    decir(tel, 'mercado pago');
    return decir(tel, '1');
  };
  const C5 = '5492944200005';
  r = pedirConMp(C5);
  chequear('al confirmar dice que manda el link', textoPara(r, C5).includes('Ya te paso el link para pagar $6.500'));
  const p5 = qPedidos.porEnviar().pop();
  chequear('el pedido va con pago mp', p5.datos.pago === 'mp');
  const sincMp = (respuesta) => crearSincronizador({
    config,
    cliente: { mandarPedido: async () => ({ id: proximo++, ...respuesta }), pedidos: async () => ({ pedidos: remotos, hasta: 1, mas: false }) },
    cuenta: cuentaFalsa, recargarConfig: () => [], enviar: async (x) => { enviados.push(...x); return x; }, log: { log: () => {}, error: () => {} },
  });
  enviados.length = 0;
  await sincMp({ estado: 'esperando_pago', pago: { url: 'https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=X', vence: 1 } }).mandarBandeja();
  chequear('le manda el link al cliente', enviados.some((x) => x.para === C5 && x.texto.includes('https://www.mercadopago.com.ar/checkout')));
  remotos = [{ id: qPedidos.porId(p5.id).remoto_id, estado: 'por_confirmar' }];
  enviados.length = 0;
  await sinc.revisarPedidos();
  chequear('cuando se acredita, "recibimos tu pago"', enviados.some((x) => x.para === C5 && x.texto.includes('Recibimos tu pago')));

  const C6 = '5492944200006';
  pedirConMp(C6);
  const p6 = qPedidos.porEnviar().pop();
  enviados.length = 0;
  await sincMp({ estado: 'por_confirmar', formaPago: 'al_entregar' }).mandarBandeja();
  chequear('sin link: le dice que paga al recibir', enviados.some((x) => x.para === C6 && x.texto.includes('lo pagás al recibir')));
  remotos = [{ id: qPedidos.porId(p6.id).remoto_id, estado: 'por_confirmar' }];
  enviados.length = 0;
  await sinc.revisarPedidos();
  chequear('y "por confirmar" no se lee como pagado', !enviados.some((x) => x.texto.includes('Recibimos tu pago')));
  delete config.pedidos.mp;

  console.log('\n— 10. El carrito del catálogo de WhatsApp —');
  const C7 = '5492944200007';
  r = motor.procesarMensaje({ de: C7, texto: '', carrito: [
    { retailerId: 'g-mila', nombre: 'Mila de WhatsApp', cantidad: 2 },
    { retailerId: null, nombre: 'Empanada de carne', cantidad: 6 },
    { retailerId: null, nombre: 'Pizza', cantidad: 1 },
  ] });
  let tc = textoPara(r, C7);
  chequear('lo anota por el ID de contenido y por el nombre', tc.includes('Recibí tu carrito') && tc.includes('2 × Milanesa con papas') && tc.includes('6 × Empanada de carne'));
  chequear('dice lo que no está en la carta', tc.includes('*Pizza* no lo tengo'));
  chequear('y sigue con la entrega', tc.includes('¿Cómo lo querés?'));
  r = motor.procesarMensaje({ de: C7, texto: '', carrito: [] });
  chequear('un carrito que no se pudo leer: que lo escriba', textoPara(r, C7).includes('No pude leer tu carrito'));

  console.log('\n— 11. La carta copiada al catálogo de WhatsApp —');
  const espejo = require('../src/core/espejo');
  const carta = [
    { gid: 'g-mila', nombre: 'Milanesa con papas', precioCentavos: 650000, hay: true },
    { gid: 'g-empa', nombre: 'Empanada de carne', precioCentavos: 120000, hay: true },
    { gid: 'g-flan', nombre: 'Flan casero', precioCentavos: 300000, hay: false },
    { gid: 'g-tarta', nombre: 'Tarta de verdura', precioCentavos: 500000, hay: false },
    { gid: 'g-pollo', nombre: 'Pollo al spiedo (por kg)', precioCentavos: 900000, hay: true },
  ];
  let plan = espejo.planEspejo({ items: carta, actuales: [] });
  chequear('vacío: crea lo que hay, sin lo que no hay ni lo que va por peso', plan.crear.map((x) => x.retailerId).join() === 'ns-g-mila,ns-g-empa');
  chequear('con el precio en milésimas', plan.crear[0].price === 6500000 && plan.crear[0].name === 'Milanesa con papas');
  const actuales = [
    { id: 'wa1', retailerId: 'ns-g-mila', name: 'Milanesa con papas', price: 6000000, isHidden: false },
    { id: 'wa2', retailerId: 'ns-g-empa', name: 'Empanada de carne', price: 1200000, isHidden: false },
    { id: 'wa3', retailerId: 'ns-g-flan', name: 'Flan casero', price: 3000000, isHidden: false },
    { id: 'wa4', retailerId: 'ns-g-vieja', name: 'Lasagna', price: 7000000, isHidden: false },
    { id: 'wa5', retailerId: 'SKU-A-MANO', name: 'Vino de la casa', price: 4000000, isHidden: false },
    { id: 'wa6', retailerId: '', name: 'Promo sin código', price: 1000000, isHidden: false },
  ];
  plan = espejo.planEspejo({ items: carta, actuales });
  chequear('cambia el precio que no coincide', plan.cambiar.some((x) => x.id === 'wa1' && x.price === 6500000));
  chequear('lo que no hay se esconde, no se borra', plan.cambiar.some((x) => x.id === 'wa3' && x.isHidden === true));
  chequear('lo que está igual no se toca', !plan.cambiar.some((x) => x.id === 'wa2'));
  chequear('lo que salió de la carta se borra', plan.borrar.join() === 'wa4');
  chequear('lo cargado a mano en WhatsApp no se toca', !JSON.stringify(plan).includes('wa5') && !JSON.stringify(plan).includes('wa6'));
  const muchos = Array.from({ length: 30 }, (_, i) => ({ gid: `g-${i}`, nombre: `Plato ${i}`, precioCentavos: 100000, hay: true }));
  plan = espejo.planEspejo({ items: muchos, actuales: [], max: 20 });
  chequear('de a poco: 20 por vuelta y el resto queda pendiente', plan.crear.length === 20 && plan.pendientes === 10);
  const C8 = '5492944200008';
  r = motor.procesarMensaje({ de: C8, texto: '', carrito: [{ retailerId: 'ns-g-empa', nombre: 'Empanada', cantidad: 12 }] });
  chequear('el carrito de un producto copiado por el bot se reconoce', textoPara(r, C8).includes('12 × Empanada de carne'));
  plan = espejo.planEspejo({ items: carta, actuales: [{ id: 'wa9', retailerId: null, name: 'milanesa  con papas', price: 5000000, isHidden: false }] });
  chequear('uno cargado a mano con el mismo nombre se adopta, no se duplica', plan.cambiar.some((x) => x.id === 'wa9' && x.retailerId === 'ns-g-mila' && x.price === 6500000)
    && !plan.crear.some((x) => x.retailerId === 'ns-g-mila'));
  const paraApp = espejo.catalogoParaLaApp([
    { id: '111', retailerId: 'ns-g-mila', name: 'Milanesa con papas', description: 'Con fritas', price: 6500000, isHidden: false },
    { id: '112', retailerId: '', name: ' Tarta de jamón y queso ', price: 5000000, isHidden: true },
    { id: '113', name: '', price: 1 },
  ]);
  chequear('el catálogo de WhatsApp para la app: precio en centavos, escondidos marcados', paraApp.length === 2
    && paraApp[0].precioCentavos === 650000 && paraApp[0].descripcion === 'Con fritas'
    && paraApp[1].nombre === 'Tarta de jamón y queso' && paraApp[1].oculto === true && paraApp[1].retailerId === null);
  let subido = null;
  let pidio = false;
  const sincWa = crearSincronizador({
    config, cuenta: cuentaFalsa, recargarConfig: () => [], enviar: async (x) => x, log: { log: () => {}, error: () => {} },
    cliente: { mandarCatalogoWa: async (items) => { subido = items; return { ok: true }; } },
    alPedirCatalogoWa: async () => { pidio = true; },
  });
  await sincWa.subirCatalogoWa(paraApp);
  chequear('sube el catálogo de WhatsApp a Nodo Sur', subido && subido.length === 2);
  await sincWa.alAviso(JSON.stringify({ bot: { catalogoWa: true } }));
  chequear('cuando la app lo pide, lo vuelve a leer', pidio);
  chequear('el catálogo se prende también desde la app', gastro.conCatalogoWhatsapp({ pedidos: { catalogo_whatsapp: true }, negocio: {} }));

  console.log('\n— 12. Las preguntas del local no se mezclan con el pedido —');
  config.preguntas = [
    { claves: ['sos un bot'], respuesta: 'Soy el asistente del local 🙂' },
    { claves: ['tienen milanesa', 'hay milanesa'], respuesta: 'Sí, de carne y con papas.' },
  ];
  const C12 = '5492944200012';
  let r12 = await decir(C12, '¿sos un bot?');
  chequear('"¿sos un bot?" con respuesta cargada la contesta el local (no pasa a una persona)', textoPara(r12, C12).includes('Soy el asistente del local'));
  config.preguntas = [];
  r12 = await decir('5492944200014', 'sos un bot?');
  chequear('sin respuesta cargada, "¿sos un bot?" sigue yendo a una persona', textoPara(r12, '5492944200014').includes('personalmente'));
  config.preguntas = [{ claves: ['tienen milanesa', 'hay milanesa'], respuesta: 'Sí, de carne y con papas.' }];
  const C15 = '5492944200015';
  await decir(C15, 'pedido');
  r12 = await decir(C15, '¿tienen milanesa?');
  chequear('armando el pedido, una pregunta del local se contesta y no se anota', textoPara(r12, C15).includes('de carne y con papas') && !textoPara(r12, C15).includes('Anotado'));
  r12 = await decir(C15, '2 milanesas');
  chequear('con cantidad sí se anota', textoPara(r12, C15).includes('2 × Milanesa con papas'));
  r12 = await decir(C15, 'hay empanadas?');
  chequear('una pregunta que el local no cargó sigue buscando en la carta', textoPara(r12, C15).includes('Empanada de carne'));
  config.preguntas = [];

  console.log('\n— 13. Modo prueba: el dueño es el cliente y al resto no se le contesta —');
  const D = config.numero_duena;
  const C16 = '5492944200016';
  let r13 = await decir(D, 'modo prueba');
  chequear('el dueño entra al modo prueba', motor.enPrueba() && textoPara(r13, D).includes('Modo prueba') && textoPara(r13, D).includes('Encargues'));
  r13 = await decir(D, 'hola');
  chequear('y lo atiende como a un cliente', textoPara(r13, D).length > 0 && !textoPara(r13, D).includes('Escribime como te salga'));
  r13 = await decir(D, 'hay milanesa?');
  chequear('le contesta con la carta', textoPara(r13, D).includes('Milanesa con papas'));
  chequear('a otro número no le contesta', (await decir(C16, 'hola')).length === 0);
  r13 = await decir(D, 'Salir');
  chequear('con "salir" vuelve a ser el dueño', !motor.enPrueba() && textoPara(r13, D).includes('Salí del modo prueba'));
  chequear('y los clientes vuelven a ser atendidos', (await decir(C16, 'hola')).length > 0);
  chequear('el dueño vuelve a tener sus comandos', textoPara(await decir(D, 'ayuda'), D).includes('modo prueba'));

  console.log('\n— 14. El primer chat de una hamburguesería (2026-10-21) —');
  catalogo.fijar([
    { gid: 'h-bcd', nombre: 'Combo Bacon Cheese Doble', precioCentavos: 1600000, hay: true },
    { gid: 'h-bcs', nombre: 'Combo Bacon Cheese Simple', precioCentavos: 1350000, hay: true },
    { gid: 'h-p2', nombre: 'Promo 2 Bacon Cheese Dobles', precioCentavos: 2990000, hay: true },
    { gid: 'h-kmd', nombre: 'Combo La Km Doble', precioCentavos: 1700000, hay: true },
    { gid: 'h-coca', nombre: 'Coca Cola 500 ml', precioCentavos: 250000, hay: true },
    { gid: 'h-agua', nombre: 'Agua sin gas 500 ml', precioCentavos: 180000, hay: true },
  ]);
  const C17 = '5492944200017';
  let r14 = await decir(C17, 'Quiero pedirte un combo');
  chequear('"quiero pedirte un combo" arranca el pedido y pregunta cuál combo', textoPara(r14, C17).includes('¿Cuál de estos?') && textoPara(r14, C17).includes('Combo La Km Doble') && !textoPara(r14, C17).includes('Gracias por escribir'));
  await decir(C17, '0');
  r14 = await decir(C17, 'Combo 2 burguera');
  chequear('"combo 2 burguera" ofrece los combos en vez de "no encontré"', textoPara(r14, C17).includes('No tengo "Combo 2 burguera"') && textoPara(r14, C17).includes('¿Cuál de estos?'));
  r14 = await decir(C17, '1');
  chequear('y se anota el elegido', textoPara(r14, C17).includes('Anotado'));
  r14 = await decir(C17, 'Burger');
  chequear('sin nada parecido, sigue diciendo que no lo encontró', textoPara(r14, C17).includes('No encontré "Burger"'));
  decir(C17, 'cancelar');
  r14 = await decir(C17, '¿Qué bebidas tienen?');
  chequear('"¿qué bebidas tienen?" lista las bebidas', textoPara(r14, C17).includes('Coca Cola') && textoPara(r14, C17).includes('Agua sin gas') && !textoPara(r14, C17).includes('Combo'));
  r14 = await decir(C17, '¿Tienen tacc?');
  chequear('una pregunta sin respuesta no dice "no encontré ese producto"', textoPara(r14, C17).includes('no la sé responder') && !textoPara(r14, C17).includes('ese producto'));

  console.log(fallas ? `\n❌ ${fallas} chequeos de gastronomía fallaron` : '\n✅ Gastronomía OK');
  process.exit(fallas ? 1 : 0);
})();
