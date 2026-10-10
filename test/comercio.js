// Asincrónico: el motor devuelve promesas (la conversación de turnos espera la red al reservar, etapa 5 de Nodo Sur).
(async () => {
// Un comercio (almacén): precio y si hay, ubicación y horarios, y pedidos para retirar en el local que quedan en la
// bandeja para Nodo Sur. Decisiones del dueño en Nodo-Sur-Pos/docs/PLAN-BOT.md (2026-10-09).
// Con la hora de Argentina, como en el celular: con UTC (la de las PCs de prueba) la pausa andaba de casualidad.
process.env.TZ = 'America/Argentina/Buenos_Aires';
const os = require('os');
const path = require('path');

const RUTA_DB = path.join(os.tmpdir(), `test_comercio_${Date.now()}.db`);
process.env.RUTA_DB = RUTA_DB;

const { armar, ejemplo, validar } = require('../src/config');
const config = armar(ejemplo(), { negocio: { rubro: 'almacen', nombre: 'La Plazoleta', direccion: 'Mitre 150' }, servicios: [] });
const db = require('../src/db');
db.abrir(RUTA_DB);
db.sembrarServicios(config.servicios);
const { crearMotor } = require('../src/core/motor');
const catalogo = require('../src/core/catalogo');
const comercio = require('../src/core/comercio');
const qPedidos = require('../src/db/consultas/pedidos');
const qClientas = require('../src/db/consultas/clientas');
const recordatorios = require('../src/core/recordatorios');
const motor = crearMotor(config);

let fallas = 0;
function chequear(nombre, cond) {
  if (cond) console.log(`  ✔ ${nombre}`);
  else { console.log(`  ✘ FALLÓ: ${nombre}`); fallas++; }
}
const DUENO = config.numero_duena;
const decir = (de, texto) => motor.procesarMensaje({ de, texto });
const textoPara = (salientes, quien) => salientes.filter((s) => s.para === quien).map((s) => s.texto).join('\n');

console.log('\n— 1. La plantilla de almacén —');
chequear('es un comercio (forma productos), sin servicios, y pasa la validación', config.forma === 'productos' && validar(config).length === 0);
chequear('pausa de 1 hora por defecto', config.pausa_minutos === 60);

console.log('\n— 2. Sin catálogo todavía —');
const C1 = '5492944100001';
let r = (await decir(C1, 'cuanto sale la coca?'));
chequear('avisa que no tiene la lista y ofrece una persona', textoPara(r, C1).includes('Todavía no tengo cargada la lista'));

catalogo.fijar([
  { gid: 'g-coca', nombre: 'Coca Cola 2,25 L', precioCentavos: 350000, hay: true },
  { gid: 'g-coca-z', nombre: 'Coca Cola Zero 2,25 L', precioCentavos: 360000, hay: true },
  { gid: 'g-pan', nombre: 'Pan lactal Bimbo', precioCentavos: 280000, hay: false },
  { gid: 'g-yerba', nombre: 'Yerba Playadito 1 kg', precioCentavos: 520050, hay: true },
]);

console.log('\n— 3. Consultas —');
r = (await decir(C1, 'hola'));
chequear('menú de comercio con 🛒 y pedido para retirar', textoPara(r, C1).includes('Consultar precios 🛒') && textoPara(r, C1).includes('Hacer un pedido para retirar'));
r = (await decir(C1, '¿cuánto sale la yerba?'));
chequear('precio con miles y centavos, y que hay', textoPara(r, C1).includes('Yerba Playadito 1 kg — $5.200,50 ✅'));
chequear('aclara que el precio es de hoy', textoPara(r, C1).includes('Precios de hoy, pueden cambiar'));
r = (await decir(C1, 'tienen pan lactal?'));
chequear('sin stock lo dice', textoPara(r, C1).includes('Pan lactal Bimbo — $2.800 ❌ sin stock'));
r = (await decir(C1, 'tienen coca'));
chequear('varias coincidencias: las dos cocas', textoPara(r, C1).includes('Coca Cola 2,25 L') && textoPara(r, C1).includes('Coca Cola Zero'));
r = (await decir(C1, '¿tienen fernet?'));
chequear('lo que no está: "no encontré", sin contar como no entendido', textoPara(r, C1).includes('No encontré ese producto'));
r = (await decir(C1, '¿dónde están?'));
chequear('ubicación y horarios', textoPara(r, C1).includes('Mitre 150') && textoPara(r, C1).includes('Horarios'));

console.log('\n— 4. Un pedido de punta a punta —');
const C2 = '5492944100002';
r = (await decir(C2, 'quiero hacer un pedido'));
chequear('arranca el pedido, para retirar', textoPara(r, C2).includes('retires en el local'));
r = (await decir(C2, '2 yerba'));
chequear('anota cantidad y subtotal', textoPara(r, C2).includes('Anotado: 2 × Yerba Playadito 1 kg — $10.401'));
r = (await decir(C2, 'pan lactal'));
chequear('sin stock no lo agrega', textoPara(r, C2).includes('No hay stock de *Pan lactal Bimbo*'));
r = (await decir(C2, 'coca'));
chequear('varias: pregunta cuál', textoPara(r, C2).includes('¿Cuál de estos?'));
r = (await decir(C2, '2'));
chequear('elige la segunda', textoPara(r, C2).includes('Anotado: 1 × Coca Cola Zero 2,25 L'));
r = (await decir(C2, 'yerba x1'));
chequear('lo repetido se suma', textoPara(r, C2).includes('Anotado: 1 × Yerba'));
r = (await decir(C2, 'listo'));
chequear('pide el nombre', textoPara(r, C2).includes('¿A nombre de quién'));
r = (await decir(C2, 'Sofi'));
const resumen = textoPara(r, C2);
chequear('resumen con 3 yerbas y la coca', resumen.includes('• 3 × Yerba Playadito 1 kg — $15.601,50') && resumen.includes('• 1 × Coca Cola Zero'));
chequear('total, retiro y aviso de precio', resumen.includes('Total aproximado: $19.201,50') && resumen.includes('retirás en el local') && resumen.includes('Precios de hoy'));
chequear('todavía no hay nada en la bandeja', qPedidos.porEnviar().length === 0);
r = (await decir(C2, '1'));
chequear('confirma y dice que le avisa', textoPara(r, C2).includes('Le pasé tu pedido al local'));
const bandeja = qPedidos.porEnviar();
chequear('queda en la bandeja, por enviar', bandeja.length === 1 && bandeja[0].estado === 'por_enviar');
const p = bandeja[0];
chequear('con el cliente y las líneas (gid, cantidad, precio de hoy)', p.datos.cliente.nombre === 'Sofi' && p.datos.cliente.telefono === C2
  && p.datos.items.length === 2 && p.datos.items[0].gid === 'g-yerba' && p.datos.items[0].cantidad === 3 && p.datos.items[0].precioCentavos === 520050);
chequear('con un id para Nodo Sur (reintentar no duplica)', /^wa-[\w-]{8,}$/.test(p.pedido_id));

console.log('\n— 5. Cuando el local lo resuelve —');
qPedidos.marcarEnviado(p.id, 77);
chequear('marcado como enviado, con el id de Nodo Sur', qPedidos.porRemotoId(77).estado === 'enviado');
chequear('se resuelve una sola vez', qPedidos.resolver(p.id, 'aceptado') === true && qPedidos.resolver(p.id, 'rechazado') === false);
const aviso = comercio.avisoDePedido(config, qPedidos.porId(p.id), 'aceptado');
chequear('aceptado: le dice al cliente que pase a retirarlo, con la dirección', aviso.para === C2 && aviso.texto.includes('confirmado') && aviso.texto.includes('Mitre 150'));
chequear('queda sin avisar hasta que salga el mensaje', qPedidos.sinAvisar().length === 1);
qPedidos.marcarAvisado(p.id);
chequear('después ya no', qPedidos.sinAvisar().length === 0);
chequear('rechazado: le ofrece una persona', comercio.avisoDePedido(config, p, 'rechazado').texto.includes('no puede preparar'));

console.log('\n— 6. Cancelar, cantidades y lo raro —');
const C3 = '5492944100003';
await decir(C3, 'pedido');
r = (await decir(C3, 'listo'));
chequear('"listo" sin nada anotado no manda nada', textoPara(r, C3).includes('Todavía no anotaste nada'));
r = (await decir(C3, '0'));
chequear('0 cancela', textoPara(r, C3).includes('no anoté nada'));
chequear('cantidadYProducto: "2 coca", "coca x3", "coca"', JSON.stringify([comercio.cantidadYProducto('2 coca'), comercio.cantidadYProducto('coca x3'), comercio.cantidadYProducto('coca')])
  === JSON.stringify([{ cantidad: 2, busqueda: 'coca' }, { cantidad: 3, busqueda: 'coca' }, { cantidad: 1, busqueda: 'coca' }]));
await decir(C3, 'pedido');
r = (await decir(C3, 'menu'));
chequear('"menú" sale del pedido', textoPara(r, C3).includes('¿Qué necesitás?'));

console.log('\n— 7. La pausa —');
const C4 = '5492944100004';
await decir(C4, 'hola');
motor.pausar(C4);
chequear('cuando el dueño contesta a mano, el bot se calla en ese chat', (await decir(C4, 'tienen coca?')).length === 0);
const vence = qClientas.porTelefono(C4).derivada_hasta;
const minutos = (new Date(`${vence.replace(' ', 'T')}Z`) - Date.now()) / 60000; // se guarda en UTC
chequear('por una hora (config.pausa_minutos)', minutos > 55 && minutos <= 61);
motor.pausar(DUENO);
chequear('pausar al dueño mismo no hace nada', !qClientas.porTelefono(DUENO));
const C5 = '5492944100005';
r = (await decir(C5, 'necesito hablar con alguien'));
chequear('pedir una persona: le avisa al dueño que el bot se calla 1 hora', textoPara(r, DUENO).includes('por 1 hora') && textoPara(r, C5).includes('le aviso al local'));
chequear('y después el bot no le contesta (chat real, 2026-10-09: le mandaba el menú)', (await decir(C5, 'hola?')).length === 0);

console.log('\n— 7b. Lo que mostró el primer chat real (2026-10-09) —');
const C6 = '5492944100006';
await decir(C6, 'hola');
r = (await decir(C6, '1'));
chequear('"1" pide el producto', textoPara(r, C6).includes('Decime qué producto buscás'));
r = (await decir(C6, 'fernet branca'));
chequear('después de "1", lo que no está dice "no encontré" (no el menú)', textoPara(r, C6).includes('No encontré') && !textoPara(r, C6).includes('¿Qué necesitás?'));
r = (await decir(C6, 'yerba'));
chequear('y se puede seguir consultando sin volver a poner "1"', textoPara(r, C6).includes('Yerba Playadito 1 kg — $5.200,50 ✅'));
r = (await decir(C6, 'coca 2.25l'));
chequear('"2.25l" encuentra "2,25 L" (medidas escritas distinto)', textoPara(r, C6).includes('Coca Cola 2,25 L'));
r = (await decir(C6, 'yerba 1kg'));
chequear('"1kg" encuentra "1 kg"', textoPara(r, C6).includes('Yerba Playadito 1 kg'));
r = (await decir(C6, 'graciias'));
chequear('"graciias" (con un error) es un gracias, no el menú', textoPara(r, C6).includes('Gracias a vos'));

const C7 = '5492944100007';
await decir(C7, 'pedido');
r = (await decir(C7, '2 yerba\n1 coca zero 2.25 l\npure de papas'));
chequear('varios productos en un mensaje: anota cada uno', textoPara(r, C7).includes('2 × Yerba Playadito 1 kg') && textoPara(r, C7).includes('1 × Coca Cola Zero 2,25 L'));
chequear('y dice cuál no encontró, sin perder los otros', textoPara(r, C7).includes('No encontré "pure de papas"'));
r = (await decir(C7, '1 yerba\ncoca\n3 coca zero'));
chequear('uno con varias opciones en el medio: pregunta cuál', textoPara(r, C7).includes('1 × Yerba') && textoPara(r, C7).includes('¿Cuál de estos'));
r = (await decir(C7, '1'));
chequear('al elegir, sigue con lo que faltaba de ese mensaje', textoPara(r, C7).includes('1 × Coca Cola 2,25 L') && textoPara(r, C7).includes('3 × Coca Cola Zero 2,25 L'));
await decir(C7, 'listo');
await decir(C7, 'Sofi');
r = (await decir(C7, '1'));
const ultimo = qPedidos.porEnviar().pop();
const cant = (gid) => (ultimo.datos.items.find((x) => x.gid === gid) || {}).cantidad;
chequear('el pedido junta todo: 3 yerbas, 1 coca y 4 coca zero', cant('g-yerba') === 3 && cant('g-coca') === 1 && cant('g-coca-z') === 4);

console.log('\n— 8. Lo del dueño en un comercio —');
r = (await decir(DUENO, 'qué tengo hoy'));
chequear('los comandos de turnos le dicen que los pedidos están en la app', textoPara(r, DUENO).includes('Encargues'));
r = (await decir(DUENO, 'ayuda'));
chequear('la ayuda de comercio: aviso y contactos', textoPara(r, DUENO).includes('mensaje a TODOS los clientes') && !textoPara(r, DUENO).includes('turno'));
chequear('no manda agenda diaria ni resumen semanal', recordatorios.agendaDiaria(config).length === 0 && recordatorios.resumenSemanal(config).length === 0);

console.log(fallas ? `\n❌ ${fallas} chequeos de comercio fallaron` : '\n✅ Comercio OK');
process.exit(fallas ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
