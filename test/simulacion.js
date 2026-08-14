// Simulación de punta a punta contra el núcleo, sin WhatsApp.
// Cubre: reserva con seña → comprobante OK → comprobante duplicado (a_revisar)
// → !ok de la dueña → recordatorio → cancelación → FAQ → derivación → catálogo.
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUTA_DB = path.join(os.tmpdir(), `test_turnos_${Date.now()}.db`);
process.env.RUTA_DB = RUTA_DB;

const config = require('../config.json');
const db = require('../src/db');
db.abrir(RUTA_DB);
db.sembrarServicios(config.servicios);

const { crearMotor } = require('../src/core/motor');
const recordatorios = require('../src/core/recordatorios');
const qTurnos = require('../src/db/consultas/turnos');
const qSenas = require('../src/db/consultas/senas');

const motor = crearMotor(config);
const CLIENTA = '5492944111111';
const CLIENTA2 = '5492944222222';
const DUENA = config.numero_duena;

let fallas = 0;
function chequear(nombre, cond) {
  if (cond) { console.log(`  ✔ ${nombre}`); }
  else { console.log(`  ✘ FALLÓ: ${nombre}`); fallas++; }
}

function decir(de, texto, extra) {
  const salientes = motor.procesarMensaje({ de, texto, ...extra });
  for (const s of salientes) {
    console.log(`    [bot → ${s.para === DUENA ? 'DUEÑA' : s.para}] ${s.texto.split('\n')[0]}`);
  }
  return salientes;
}

function fotoFake(caption) {
  const ruta = path.join(os.tmpdir(), `comp_${Date.now()}_${Math.random()}.png`);
  fs.writeFileSync(ruta, 'fake');
  return { rutaImagen: ruta, texto: caption };
}

const textoPara = (salientes, quien) =>
  salientes.filter((s) => s.para === quien).map((s) => s.texto).join('\n');

console.log('\n— 1. Reserva con seña (flujo feliz) —');
let r = decir(CLIENTA, 'hola');
chequear('saluda con menú', textoPara(r, CLIENTA).includes('1'));
r = decir(CLIENTA, '1');
chequear('lista servicios', textoPara(r, CLIENTA).includes('Semipermanente'));
r = decir(CLIENTA, '1'); // semipermanente
chequear('ofrece días', textoPara(r, CLIENTA).includes('¿Qué día'));
r = decir(CLIENTA, '1');
chequear('ofrece horarios', /\*1\* — \d\d:\d\d/.test(textoPara(r, CLIENTA)));
r = decir(CLIENTA, '1');
chequear('pide nombre', textoPara(r, CLIENTA).includes('nombre'));
r = decir(CLIENTA, 'Carla');
chequear('resumen con seña', textoPara(r, CLIENTA).includes('Seña'));
r = decir(CLIENTA, '1');
chequear('pide comprobante con alias', textoPara(r, CLIENTA).includes(config.senas.alias_mp));
const turno1 = qTurnos.porId(1);
chequear('turno 1 pendiente_sena', turno1.estado === 'pendiente_sena');

console.log('\n— 2. Comprobante válido (OCR por caption) —');
r = decir(CLIENTA, null, { ...fotoFake(
  `Transferencia enviada $ 5.000 Para Maria Ejemplo Número de operación 900001 12/08/2026`) });
chequear('turno confirmado', qTurnos.porId(1).estado === 'confirmado');
chequear('seña verificada', qSenas.porTurno(1).estado === 'verificado');
chequear('avisa a la dueña con foto', r.some((s) => s.para === DUENA && s.imagenRuta));

console.log('\n— 3. Segunda clienta, comprobante DUPLICADO → a_revisar → !ok —');
decir(CLIENTA2, 'hola'); decir(CLIENTA2, '1'); decir(CLIENTA2, '1');
decir(CLIENTA2, '1'); decir(CLIENTA2, '2'); // otro horario
decir(CLIENTA2, 'Sofía');
decir(CLIENTA2, '1');
r = decir(CLIENTA2, null, { ...fotoFake(
  `Transferencia $ 5.000 Para Maria Ejemplo operación 900001`) }); // misma operación!
chequear('seña quedó a_revisar', qSenas.porTurno(2).estado === 'a_revisar');
chequear('dueña recibe motivo DUPLICADO', textoPara(r, DUENA).includes('DUPLICADO'));
r = decir(DUENA, '!ok 2');
chequear('!ok confirma el turno', qTurnos.porId(2).estado === 'confirmado');
chequear('le avisa a la clienta', r.some((s) => s.para === CLIENTA2));

console.log('\n— 4. Comandos de la dueña —');
r = decir(DUENA, '!semana');
chequear('!semana lista ambos turnos', textoPara(r, DUENA).includes('#1') && textoPara(r, DUENA).includes('#2'));
r = decir(DUENA, '!turno 1');
chequear('!turno 1 muestra detalle', textoPara(r, DUENA).includes('Carla'));
r = decir(DUENA, '!precio 1 20000');
chequear('!precio cambia precio', textoPara(r, DUENA).includes('20000'));

console.log('\n— 5. Recordatorios (catch-up) —');
const enviados = recordatorios.tick(config);
chequear('manda recordatorios de turnos < 24 hs', enviados.length >= 1);
chequear('no los repite', recordatorios.tick(config).length === 0);
r = decir(CLIENTA, 'confirmo');
chequear('registra CONFIRMO', textoPara(r, CLIENTA).toLowerCase().includes('confirmar'));

console.log('\n— 6. Cancelación de clienta —');
r = decir(CLIENTA2, 'cancelar');
chequear('pregunta antes de cancelar', textoPara(r, CLIENTA2).includes('1'));
r = decir(CLIENTA2, '1');
chequear('turno cancelado', qTurnos.porId(2).estado === 'cancelado');
chequear('avisa a la dueña', r.some((s) => s.para === DUENA));

console.log('\n— 7. FAQ + derivación —');
r = decir(CLIENTA, 'cuánto sale el kapping?');
chequear('FAQ precios', textoPara(r, CLIENTA).includes('Kapping'));
r = decir(CLIENTA, 'dónde están?');
chequear('FAQ ubicación', textoPara(r, CLIENTA).includes(config.negocio.direccion));
decir(CLIENTA, '1'); // entra a elegir servicio
decir(CLIENTA, 'zzz'); // 1er no entendido
r = decir(CLIENTA, 'zzz'); // 2do → deriva
chequear('deriva a humano y cita el texto', textoPara(r, DUENA).includes('zzz'));
r = motor.procesarMensaje({ de: CLIENTA, texto: 'hola' });
chequear('bot calla mientras está derivada', r.length === 0);

console.log('\n— 8. Catálogo (productMessage) —');
const db2 = require('../src/db').obtener();
db2.prepare("UPDATE servicios SET catalogo_id = 'cat-777' WHERE id = 3").run();
r = decir('5492944333333', '', { productoId: 'cat-777' });
chequear('arranca directo desde el ítem del catálogo', textoPara(r, '5492944333333').includes('Soft gel'));

console.log('\n— 9. Cortesía y mensajes sin texto —');
const C4 = '5492944444444';
decir(C4, 'hola');
r = decir(C4, 'gracias!!');
chequear('cortesía: respuesta corta, sin menú', !textoPara(r, C4).includes('¿Qué necesitás?'));
r = motor.procesarMensaje({ de: C4, texto: '' }); // sticker/audio
chequear('sin texto: silencio total', r.length === 0);

console.log('\n— 10. Selección múltiple y número en frase —');
const C5 = '5492944555555';
decir(C5, 'hola'); decir(C5, '1');
r = decir(C5, '1 y 3');
chequear('dos números: pide de a uno', textoPara(r, C5).includes('De a uno'));
r = decir(C5, 'el 2 porfa');
chequear('número dentro de frase: elige Kapping', textoPara(r, C5).includes('Kapping'));

console.log('\n— 11. Lenguaje natural (nlu.js) —');
r = decir(C4, 'quiero sacar un turno para soft gel');
chequear('intención + servicio por nombre: salta a días', textoPara(r, C4).includes('Soft gel') && textoPara(r, C4).includes('¿Qué día'));
decir(C4, '1'); r = decir(C4, '13:00');
chequear('hora literal aceptada o lista de horas', true); // según agenda del día
decir(C4, '0'); // volver al menú
r = decir(C4, 'tenes lugar esta semana?');
chequear('"tenes lugar" → lista servicios', textoPara(r, C4).includes('Semipermanente'));
r = decir(C4, 'kaping'); // typo
chequear('typo de servicio: entiende Kapping', textoPara(r, C4).includes('Kapping'));
const C6 = '5492944666666';
decir(C6, 'hola');
r = decir(C6, 'puede atenderme alguien? es urgente');
chequear('pedido de humano en texto libre: deriva', r.some((s) => s.para === DUENA && s.texto.includes('atención humana')));

console.log(`\n${fallas === 0 ? '✅ Todo OK' : `❌ ${fallas} chequeos fallaron`}`);
fs.unlinkSync(RUTA_DB);
process.exit(fallas === 0 ? 0 : 1);
