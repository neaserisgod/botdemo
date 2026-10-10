// Frases reales, escritas como se escriben por WhatsApp, y lo que el bot tiene que hacer con cada una, por rubro.
// Es lo que mantiene a prueba el diccionario (src/core/diccionario/): cada palabra nueva tiene que pasar por acá, y
// cada chat real que salga mal suma su frase. Empezó con las ~70 de la sonda del 2026-10-09.
//
// Cada rubro corre en su propio proceso (los servicios de uno pisarían los del otro en la misma base).
process.env.TZ = 'America/Argentina/Buenos_Aires';
const { spawnSync } = require('child_process');

const RUBROS = ['unas', 'barberia', 'peluqueria', 'estetica', 'almacen', 'kiosco', 'fiambreria'];
const rubro = process.argv[2];

if (!rubro) {
  let fallas = 0;
  for (const r of RUBROS) {
    const p = spawnSync(process.execPath, [__filename, r], { encoding: 'utf8', env: process.env });
    process.stdout.write(p.stdout.split('\n').filter((l) => !/ExperimentalWarning|trace-warnings/.test(l)).join('\n'));
    if (p.status !== 0) { fallas++; if (p.stderr && !/ExperimentalWarning/.test(p.stderr)) process.stdout.write(p.stderr); }
  }
  console.log(fallas ? `\n❌ Frases: fallaron ${fallas} rubros` : '\n✅ Frases OK');
  process.exit(fallas ? 1 : 0);
}

const os = require('os');
const path = require('path');
process.env.RUTA_DB = path.join(os.tmpdir(), `test_frases_${rubro}_${Date.now()}.db`);
const { armar, ejemplo } = require('../src/config');
const { serviciosDe } = require('../src/plantillas');
const db = require('../src/db');
db.abrir(process.env.RUTA_DB);
const config = armar(ejemplo(), {
  negocio: { rubro, nombre: 'Prueba' },
  servicios: serviciosDe(rubro),
  respuestas: { pagos: 'Aceptamos efectivo, transferencia y Mercado Pago 💳' },
  preguntas: [{ claves: ['wifi', 'wi fi'], respuesta: 'Sí, hay wifi: la clave está en el mostrador 📶' }],
});
db.sembrarServicios(config.servicios || []);
const motor = require('../src/core/motor').crearMotor(config);
const catalogo = require('../src/core/catalogo');
const qClientas = require('../src/db/consultas/clientas');
const qTurnos = require('../src/db/consultas/turnos');
const qPedidos = require('../src/db/consultas/pedidos');
const fechas = require('../src/core/fechas');

// Los pesables como los publica la app de Nodo Sur: "(por kg)" y el precio por kilo. "Pan francés x kg" es un catálogo
// cargado a mano: también se pesa.
catalogo.fijar([
  ['Coca Cola 2,25 L', 350000], ['Coca Cola Zero 1,5 L', 300000], ['Cerveza Quilmes lata 473 ml', 180000],
  ['Pan francés x kg', 250000], ['Alfajor Jorgito', 90000], ['Papel higiénico Higienol x4', 400000],
  ['Fernet Branca 750 ml', 1200000], ['Jamón cocido Paladini (por kg)', 1500000], ['Queso cremoso (por kg)', 900000],
  ['Queso barra (por kg)', 1100000], ['Salame Milán (por kg)', 2000000],
  ['Cigarrillos Marlboro box 20', 450000], ['Leche La Serenísima 1 L', 150000], ['Huevos x 6', 180000],
  ['Huevos x 12', 300000], ['Galletitas 9 de Oro', 120000], ['Seven Up 1,5 L', 280000], ['Yerba Playadito 1 kg', 520000],
].map(([nombre, precioCentavos], i) => ({ gid: `g${i}`, nombre, precioCentavos, hay: true })));

// Días hábiles (lunes a viernes) a 2 días o más: abiertos a las 10 y a las 17 en la config de ejemplo.
function diaHabil(desde) {
  for (let i = desde; ; i++) {
    const d = new Date(Date.now() + i * 86400000);
    const ymd = fechas.aTexto(d).slice(0, 10);
    if (d.getDay() >= 1 && d.getDay() <= 5) return { i, ymd, nombre: fechas.nombreDia(ymd) };
  }
}
const D1 = diaHabil(2);
const D2 = diaHabil(D1.i + 1);
const nombreDia = (d) => d.nombre.replace('miercoles', 'miércoles').replace('sabado', 'sábado');

let n = 0, fallas = 0;
// Una conversación de un cliente nuevo. `espera` mira la última respuesta: { incluye, no, silencio, aviso, sinAviso, estado, y }.
function caso(nombre, mensajes, espera, prep) {
  const de = `54911660${String(++n).padStart(5, '0')}`;
  if (prep) prep(de);
  let r = [];
  for (const m of [].concat(mensajes)) r = motor.procesarMensaje(typeof m === 'string' ? { de, texto: m } : { de, ...m });
  const texto = r.filter((s) => s.para === de).map((s) => s.texto).join('\n');
  const aviso = r.some((s) => s.para === config.numero_duena);
  const problemas = [];
  for (const i of [].concat(espera.incluye || [])) if (!texto.includes(i)) problemas.push(`no dice "${i}"`);
  for (const i of [].concat(espera.no || [])) if (texto.includes(i)) problemas.push(`dice "${i}"`);
  if (espera.silencio && texto) problemas.push('no se calla');
  if (espera.aviso && !aviso) problemas.push('no le avisa al negocio');
  if (espera.sinAviso && aviso) problemas.push('le avisa al negocio (no debía)');
  if (espera.estado && qClientas.porTelefono(de)?.estado_conv !== espera.estado) problemas.push(`queda en ${qClientas.porTelefono(de)?.estado_conv}, no en ${espera.estado}`);
  if (espera.y && !espera.y(de)) problemas.push('lo de después no da');
  if (problemas.length) {
    fallas++;
    console.log(`  ✘ FALLÓ: ${nombre}  [${[].concat(mensajes).map((m) => (typeof m === 'string' ? m : `(${m.tipo})`)).join(' | ')}]\n      ${problemas.join('; ')}\n      → ${texto.replace(/\n+/g, ' ⏎ ').slice(0, 260)}`);
  } else console.log(`  ✔ ${nombre}`);
}

// Un cliente con nombre y un turno confirmado para D1 a las 10:00 (para cambiar, cancelar, avisar que llega tarde).
let turnoId = null;
const conTurno = (servicioId) => (de) => {
  const c = qClientas.obtenerOCrear(de);
  qClientas.guardarNombre(c.id, 'Sofi');
  const s = config.servicios.find((x) => x.id === servicioId);
  turnoId = qTurnos.crear(c.id, s.id, `${D1.ymd} 10:00`, fechas.sumarMinutos(`${D1.ymd} 10:00`, s.duracion_min), 'confirmado');
};

const COMUNES = () => {
  console.log('\n— Lo que vale para todos los rubros —');
  caso('"graxx" es un gracias', 'graxx', { incluye: 'Gracias a vos' });
  caso('"gracias genia!" es un gracias', 'gracias genia!', { incluye: 'Gracias a vos' });
  caso('"okk" es un gracias', 'okk', { incluye: 'Gracias a vos' });
  caso('"👍🏻" (con tono de piel) es un gracias', '👍🏻', { incluye: 'Gracias a vos' });
  caso('"mil gracias!! 🙌" es un gracias', 'mil gracias!! 🙌', { incluye: 'Gracias a vos' });
  caso('"jajaja": silencio', 'jajaja', { silencio: true });
  caso('"jsjsjs": silencio', 'jsjsjs', { silencio: true });
  caso('"q onda" es un saludo', 'q onda', { incluye: '¿Qué necesitás?' });
  caso('"buen día! cómo va?" es un saludo', 'buen día! cómo va?', { incluye: '¿Qué necesitás?' });
  caso('"holaaa" es un saludo', 'holaaa', { incluye: '¿Qué necesitás?' });
  caso('"aceptan mercado pago?" contesta lo configurado', 'che una pregunta, aceptan mercado pago?', { incluye: 'Mercado Pago', sinAviso: true });
  caso('"se puede pagar con tarjeta?" también', 'se puede pagar con tarjeta?', { incluye: 'Mercado Pago' });
  caso('"necesito hablar con alguien" pasa a una persona', 'necesito hablar con alguien', { aviso: true, incluye: 'le aviso' });
  caso('"sos un bot?" pasa a una persona', 'sos un bot?', { aviso: true });
  caso('"menuu" vuelve al menú', ['hola', 'menuu'], { incluye: 'Volvamos al principio' });
  caso('una pregunta que cargó el negocio ("tienen wifi?")', 'tienen wifi?', { incluye: 'hay wifi' });
};

// La regla (el dueño, 2026-10-09): el cliente escribe mal, apurado, enojado, todo junto, manda audios y no lee. El bot
// tiene que entenderlo igual, y si no puede, pasarlo a una persona antes de que se enoje más.
const CLIENTE_DIFICIL = () => {
  console.log('\n— El cliente difícil: escribe mal, apurado, enojado —');
  caso('"1." es la opción 1', '1.', { no: '¿Qué necesitás?' });
  caso('"el 1" es la opción 1', 'el 1', { no: '¿Qué necesitás?' });
  caso('"opcion 3": ubicación y horarios', 'opcion 3', { incluye: 'Horarios' });
  caso('"tres" (en letras): ubicación y horarios', 'tres', { incluye: 'Horarios' });
  caso('"la cuarta": una persona', 'la cuarta', { aviso: true });
  caso('"??" después del menú: corto, no el menú otra vez', ['hola', '??'], { incluye: 'Acá estoy', no: '¿Qué necesitás?' });
  caso('"hola???" y "contestá": a la segunda, una persona', ['hola', 'hola???', 'contesta'], { aviso: true, incluye: 'Perdón la demora' });
  caso('"hola" de alguien que recién llega es un saludo (no apuro)', 'hola', { incluye: '¿Qué necesitás?' });
  caso('"bot de mierda": perdón y una persona, sin discutir', 'bot de mierda', { aviso: true, incluye: 'Perdón por la molestia', no: '¿Qué necesitás?' });
  caso('"la concha de tu madre contestá"', 'la concha de tu madre contestá', { aviso: true, incluye: 'Perdón' });
  caso('"sos un inútil"', 'sos un inútil', { aviso: true });
  caso('"😡😡"', '😡😡', { aviso: true });
  caso('"che boludo" no es un insulto (acá es de todos los días)', 'che boludo', { sinAviso: true });
  caso('dos cosas sin sentido seguidas: una persona (no el menú dos veces)', ['asdkjh', 'qwerty'], { aviso: true, incluye: 'no te estoy entendiendo' });
  caso('una sola: el menú, y queda anotado', 'asdkjh', { incluye: '¿Qué necesitás?', sinAviso: true });
  caso('un audio: le pide que lo escriba (no silencio)', [{ texto: '', tipo: 'audio' }], { incluye: ['no puedo escuchar audios', 'hablar con alguien'] });
  caso('un audio a mitad de algo no le hace perder el paso', ['hola', '3', { texto: '', tipo: 'audio' }], { incluye: 'audios', estado: 'inicio' });
  caso('"MENU" en mayúsculas', ['hola', 'MENU'], { incluye: 'Volvamos al principio' });
};

const TURNOS_DIFICIL = () => {
  console.log('\n— Turnos: el cliente difícil —');
  caso('"kiero un tunro" (dos errores)', 'kiero un tunro', { incluye: '¿Qué servicio querés?' });
  caso('"qiero reserbar"', 'qiero reserbar', { incluye: '¿Qué servicio querés?' });
  caso('"quierounturno" (todo pegado)', 'quierounturno', { incluye: '¿Qué servicio querés?' });
  caso('"kansela el turno" (como suena)', 'kansela el turno', { incluye: '¿Cancelo tu turno' }, conTurno(1));
  caso('"cnacelar" (letras dadas vuelta)', 'cnacelar', { incluye: '¿Cancelo tu turno' }, conTurno(1));
  caso('"KUANTO SALE" en mayúsculas y con k', `KUANTO SALE EL ${config.textos.ejemplo_servicio.toUpperCase()}`, { incluye: '$' });
  caso('"nesesito turno alas 5"', `nesesito turno alas 5`, { incluye: '¿Qué servicio querés?' });
  caso('"dame un turno la puta madre": el turno (el insulto no tapa el pedido)', 'dame un turno la puta madre', { incluye: '¿Qué servicio querés?', sinAviso: true });
  caso('"??" a mitad de la reserva: le repite lo que estaba eligiendo', [`quiero ${config.servicios[0].nombre.toLowerCase()}`, '??'], { incluye: ['Acá estoy', 'día'], estado: 'eligiendo_dia' });
  caso('insulto a mitad de la reserva: una persona', [`quiero ${config.servicios[0].nombre.toLowerCase()}`, 'sos un inutil'], { aviso: true });
};

const TURNOS_COMUNES = () => {
  console.log('\n— Turnos: cambiar, llegar tarde, cancelar —');
  caso('"quiero cambiar el turno" sin turno: no hay ninguno', 'quiero cambiar el turno', { incluye: 'No encontré ningún turno tuyo' });
  caso('"quiero cambiar el turno": ofrece otro día del mismo servicio', 'quiero cambiar el turno', { incluye: ['Cambiamos tu turno', '¿Qué día'], estado: 'eligiendo_dia' }, conTurno(1));
  caso(`"no puedo ir el ${D1.nombre}, me lo pasás para el ${D2.nombre}?" lo cambia (no lo cancela)`, `no puedo ir el ${nombreDia(D1)}, me lo pasas para el ${nombreDia(D2)}?`,
    { incluye: ['Cambiamos tu turno', 'Horarios libres'], no: 'Cancelo' }, conTurno(1));
  caso('cambiarlo de punta a punta mueve el mismo turno', [`me lo pasas para el ${D2.nombre}?`, '1', '1'],
    { incluye: 'quedó para', y: () => qTurnos.porId(turnoId).inicio.startsWith(D2.ymd) && qTurnos.porId(turnoId).estado === 'confirmado' }, conTurno(1));
  caso('"no llego a las 10, puedo a las 11?" lo cambia a las 11', 'no llego a las 10, puedo a las 11?',
    { incluye: ['11:00', 'repasemos'], no: 'Cancelo' }, conTurno(1));
  caso('"llego 10 min tarde": gracias y le avisa al negocio', 'llego 10 min tarde', { incluye: 'Gracias por avisar', aviso: true }, conTurno(1));
  caso('"voy demorada, perdón!" también', 'voy demorada, perdón!', { incluye: 'Gracias por avisar', aviso: true }, conTurno(1));
  caso('"no quiero cancelar" no cancela', 'no quiero cancelar, ahi voy', { no: '¿Cancelo', incluye: 'Gracias por confirmar' }, conTurno(1));
  caso('"me lo cancelas porfa" cancela', 'me lo cancelas porfa', { incluye: '¿Cancelo tu turno' }, conTurno(1));
  caso('"tenes algo el finde?" es querer un turno', 'tenes algo el finde?', { incluye: '¿Qué servicio querés?' });
  caso('"la semana que viene a la tarde" es querer un turno', 'la semana que viene a la tarde', { incluye: '¿Qué servicio querés?' });
  caso('"dsp del mediodia" es querer un turno', 'dsp del mediodia', { incluye: '¿Qué servicio querés?' });
  caso('"tenes lugar mañana?" es querer un turno', 'tenes lugar mañana?', { incluye: '¿Qué servicio querés?' });
  caso('"a que hora tenes turno mañana?" es querer un turno (no el horario del local)', 'a que hora tenes turno mañana?', { incluye: '¿Qué servicio querés?' });
  caso('"a que hora abren el sabado?": horarios', 'a que hora abren el sabado?', { incluye: 'Horarios' });
  caso('"otro dia paso" no es cambiar un turno', 'otro dia paso', { no: 'turno tuyo para cambiar' });
  caso('"mejor el kapping"/"mejor el corte" sin turno sigue como reserva', `mejor el ${config.textos.ejemplo_servicio}`, { incluye: '¿Qué día' });
  caso('"como pago la seña?": el alias', 'como pago la seña?', { incluye: 'Alias', sinAviso: true });
  caso('"tienen estacionamiento?" (sin respuesta): el menú, y queda anotado', 'tienen estacionamiento?', { incluye: '¿Qué necesitás?' });
  caso('la dueña ve lo que no se entendió', [], {}, () => {});
  const r = motor.procesarMensaje({ de: config.numero_duena, texto: 'que no entendiste?' }).map((s) => s.texto).join('\n');
  if (r.includes('estacionamiento')) console.log('  ✔ "qué no entendiste": la dueña ve "tienen estacionamiento?"');
  else { fallas++; console.log(`  ✘ FALLÓ: "qué no entendiste" no muestra lo de estacionamiento → ${r.slice(0, 200)}`); }
};

// A mitad de un paso (eligiendo día u hora, confirmando): cambiar de tema no es "no entender". Del simulador (2026-10-09).
const TURNOS_EN_PASO = () => {
  console.log('\n— Turnos: a mitad de la reserva —');
  const s1 = config.servicios[0].nombre.toLowerCase();
  const hastaHora = [`quiero ${s1}`, '1'];
  caso('"gracias genia!" eligiendo la hora: sigue en la hora, sin "no entiendo"', [...hastaHora, 'gracias genia!'], { incluye: 'Elegí un número de la lista de horarios', estado: 'eligiendo_hora', no: 'no te estoy entendiendo' });
  caso('"¿cuánto sale?" eligiendo la hora: el precio, y sigue en la hora', [...hastaHora, `cuanto sale el ${s1}?`], { incluye: ['$', 'Elegí un número de la lista de horarios'], estado: 'eligiendo_hora', sinAviso: true });
  caso('dos preguntas seguidas no pasan la charla a una persona', [...hastaHora, 'gracias!', 'como se paga?'], { sinAviso: true, no: 'no te estoy entendiendo' });
  caso('"jajaja" a mitad: silencio', [...hastaHora, 'jajaja'], { silencio: true });
  caso('"me arrepentí, cancelá" a mitad (sin turno): lo deja', [`quiero ${s1}`, 'cancelalo'], { incluye: 'no reservé nada', estado: 'inicio' });
  caso(`"el ${D1.nombre}" eligiendo el día: ese día`, [`quiero ${s1}`, `el ${nombreDia(D1)}`], { incluye: 'Horarios libres', estado: 'eligiendo_hora' });
  // Si mañana el local está cerrado (un sábado, con el domingo cerrado), lo dice y ofrece otros días: el caso no puede
  // depender del día en que se corre el test.
  const manana = fechas.aTexto(new Date(Date.now() + 86400000)).slice(0, 10);
  caso('"mañana" eligiendo el día', [`quiero ${s1}`, 'mañana'], config.horarios[fechas.nombreDia(manana)]
    ? { estado: 'eligiendo_hora' } : { estado: 'eligiendo_dia', incluye: 'no tengo lugar' });
  const conNombre = (de) => qClientas.guardarNombre(qClientas.obtenerOCrear(de).id, 'Sofi');
  caso(`"a las 5" eligiendo la hora: las 17`, [`quiero ${s1} el ${nombreDia(D2)}`, 'a las 5'], { incluye: ['repasemos', '17:00'] }, conNombre);
  caso('"16 hs" eligiendo la hora', [`quiero ${s1} el ${nombreDia(D2)}`, '16 hs'], { incluye: ['repasemos', '16:00'] }, conNombre);
  caso('"si" para confirmar (en vez de 1)', [`quiero ${s1} el ${nombreDia(D2)} a las 13`, 'si'], { no: ['Respondé *1*', 'no te estoy entendiendo'],
    y: (de) => !!qTurnos.proximoDeClienta(qClientas.porTelefono(de).id, fechas.aTexto(new Date())) }, conNombre);
  caso('"dale" para confirmar', [`quiero ${s1} el ${nombreDia(D2)} a las 14`, 'dale'], { no: ['Respondé *1*', 'no te estoy entendiendo'],
    y: (de) => !!qTurnos.proximoDeClienta(qClientas.porTelefono(de).id, fechas.aTexto(new Date())) }, conNombre);
  caso('"si" para cancelar un turno', ['me lo cancelas', 'si'], { incluye: 'quedó cancelado' }, conTurno(1));
  caso('"no" para mantenerlo', ['me lo cancelas', 'no'], { incluye: 'sigue en pie' }, conTurno(1));
};

const COMERCIO_EN_PASO = () => {
  console.log('\n— Comercio: a mitad del pedido —');
  caso('"gracias" a mitad del pedido: sigue, sin "no entiendo"', ['pedido', 'alfajor', 'gracias'], { incluye: 'listo', estado: 'armando_pedido', no: 'no te estoy entendiendo' });
  caso('"¿hacen envíos?" a mitad del pedido: contesta y sigue', ['pedido', 'alfajor', 'hacen envios?'], { incluye: ['retirar en el local', '¿Algo más?'], estado: 'armando_pedido' });
  caso('"quiero 2 cocas y 2 alfajores" en el primer mensaje: pregunta qué coca y sigue con los alfajores', ['quiero 2 cocas y 2 alfajores', '1'], { incluye: ['2 × Coca Cola 2,25 L', '2 × Alfajor Jorgito'], estado: 'armando_pedido' });
  caso('"tenés coca?" no arranca un pedido', 'tenes coca?', { estado: 'inicio', incluye: 'Coca Cola' });
  caso('"listo gracias" termina el pedido', ['pedido', 'alfajor', 'listo gracias'], { incluye: '¿A nombre de quién' });
  caso('"si" para confirmar el pedido', ['pedido', 'alfajor', 'listo', 'Sofi', 'si'], { incluye: 'Le pasé tu pedido' });
};

const PRUEBAS = {
  unas() {
    COMUNES();
    CLIENTE_DIFICIL();
    TURNOS_DIFICIL();
    TURNOS_COMUNES();
    TURNOS_EN_PASO();
    console.log('\n— Uñas —');
    caso('"hola quiero un semi": pregunta manos o pies', 'hola quiero un semi', { incluye: ['Semipermanente manos', 'Semipermanente pies'], no: 'Kapping' });
    caso('"cuanto sale el kapping?": ese precio, no la lista', 'cuanto sale el kapping?', { incluye: ['Kapping rubber', '$22000'], no: 'Esculpidas' });
    caso('"quiero esculpidas acrilicas"', 'quiero esculpidas acrilicas', { incluye: ['Esculpidas en polygel', '¿Qué día'] });
    caso('"alguien me dice el precio del semi?": el precio, sin pasar a una persona', 'alguien me dice el precio del semi?', { incluye: '$18000', sinAviso: true });
    caso('"q precio tiene la manicura?": semi de manos', 'q precio tiene la manicura?', { incluye: ['Semipermanente manos', '$18000'], no: 'pies' });
    caso('"hacen pedicura?": semi de pies', 'hacen pedicura?', { incluye: 'Semipermanente pies' });
    caso('"me haces las uñas?" es querer un turno', 'me haces las uñas?', { incluye: '¿Qué servicio querés?' });
    caso('"capping" con c', 'quiero capping', { incluye: 'Kapping rubber' });
    caso('"me sacas el esmalte?": retiro', 'me sacas el esmalte?', { incluye: 'Retiro' });
    caso('"pestañas": lifting', 'quiero hacerme las pestañas', { incluye: 'Lifting de pestañas' });
    caso('"precio del kapping?" y "si": arranca la reserva', ['precio del kapping?', 'si'], { incluye: ['Kapping rubber', '¿Qué día'] });
    caso(`"semi de manos el ${D1.nombre} a las 3": 15:00`, `semi de manos el ${nombreDia(D1)} a las 3`, { incluye: '15:00', no: '03:00' });
    caso(`"semi de manos el ${D1.nombre} a las 10 de la mañana": 10:00`, `semi de manos el ${nombreDia(D1)} a las 10 de la mañana`, { incluye: '10:00' });
    caso(`"semi de manos el ${D1.nombre} a la tarde": solo horarios de la tarde`, `semi de manos el ${nombreDia(D1)} a la tarde`, { incluye: ['15:00', 'Horarios libres'], no: '09:00' });
  },

  barberia() {
    COMUNES();
    CLIENTE_DIFICIL();
    TURNOS_DIFICIL();
    TURNOS_COMUNES();
    TURNOS_EN_PASO();
    console.log('\n— Barbería —');
    caso('"quiero cortarme el pelo"', 'quiero cortarme el pelo', { incluye: ['Corte clásico', '¿Qué día'] });
    caso('"me rapas?"', 'me rapas?', { incluye: 'Corte clásico' });
    caso('"un rebaje"', 'un rebaje', { incluye: 'Corte clásico' });
    caso('"corte para nene"', 'corte para nene', { incluye: 'Corte clásico' });
    caso('"quiero hacerme la barba": pregunta cuál', 'quiero hacerme la barba', { incluye: ['Corte + barba', 'Perfilado de barba'], estado: 'eligiendo_servicio' });
    caso('"me perfilas la barba?"', 'me perfilas la barba?', { incluye: ['Perfilado de barba', '¿Qué día'] });
    caso('"corte y barba"', 'corte y barba', { incluye: 'Corte + barba' });
    caso('"cuanto el corte con barba": ese precio, no la reserva', 'cuanto el corte con barba', { incluye: ['Corte + barba', '$17000'], no: '¿Qué día' });
    caso('"hacen mechitas?": platinado', 'hacen mechitas?', { incluye: 'Platinado' });
    caso('"decoloracion cuanto sale?": precio del platinado', 'decoloracion cuanto sale?', { incluye: ['Platinado', '$38000'] });
    caso('"taper fade"', 'taper fade', { incluye: 'Fade / degradé' });
    caso('"afeitada con navaja"', 'afeitada con navaja', { incluye: 'Afeitado con navaja' });
    caso(`"quiero un corte el ${D1.nombre} a las 5": 17:00 (no las 5 de la mañana)`, `quiero un corte el ${nombreDia(D1)} a las 5`, { incluye: '17:00' });
    caso(`"un corte el ${D1.nombre} tipo 4 y media": 16:30`, `un corte el ${nombreDia(D1)} tipo 4 y media`, { incluye: '16:30' });
  },

  peluqueria() {
    COMUNES();
    CLIENTE_DIFICIL();
    TURNOS_DIFICIL();
    TURNOS_COMUNES();
    TURNOS_EN_PASO();
    console.log('\n— Peluquería —');
    caso('"quiero un corte": pregunta dama o caballero', 'quiero un corte', { incluye: ['Corte de dama', 'Corte de caballero'], no: 'Brushing' });
    caso('"quiero cortarme el pelo": pregunta cuál', 'quiero cortarme el pelo', { incluye: ['Corte de dama', 'Corte de caballero'] });
    caso('"corte de mujer"', 'corte de mujer', { incluye: ['Corte de dama', '¿Qué día'] });
    caso('"corte para mi marido"', 'corte para mi marido', { incluye: ['Corte de caballero', '¿Qué día'] });
    caso('"cortarme las puntas": pregunta cuál', 'quiero cortarme las puntas', { incluye: 'Corte de dama' });
    caso('"me queres teñir las raices?": color', 'me queres teñir las raices?', { incluye: 'Color' });
    caso('"tapar las canas cuanto sale?": precio del color', 'tapar las canas cuanto sale?', { incluye: ['Color', '$30000'] });
    caso('"hacen balayage?"', 'hacen balayage?', { incluye: 'Mechas / balayage' });
    caso('"unos reflejos"', 'quiero unos reflejos', { incluye: 'Mechas / balayage' });
    caso('"queratina" con q', 'cuanto sale la queratina?', { incluye: ['Alisado con keratina', '$55000'] });
    caso('"un alisado progresivo"', 'quiero un alisado progresivo', { incluye: 'Alisado con keratina' });
    caso('"un peinado para un casamiento": brushing', 'necesito un peinado para un casamiento', { incluye: 'Brushing' });
    caso('"botox capilar": nutrición', 'hacen botox capilar?', { incluye: 'Nutrición capilar' });
    caso('"el color pide seña"', ['quiero color', '1', '1', 'Sofi', 'si'], { incluye: 'seña' });
  },

  estetica() {
    COMUNES();
    CLIENTE_DIFICIL();
    TURNOS_DIFICIL();
    TURNOS_COMUNES();
    TURNOS_EN_PASO();
    console.log('\n— Estética —');
    caso('"quiero depilarme": pregunta qué zona', 'quiero depilarme', { incluye: ['Depilación piernas', 'Depilación cavado', 'Depilación rostro'] });
    caso('"cera en las piernas"', 'cera en las piernas', { incluye: ['Depilación piernas', '¿Qué día'] });
    caso('"cuanto el cavado?": ese precio', 'cuanto el cavado?', { incluye: ['Depilación cavado', '$9000'], no: 'piernas' });
    caso('"me sacas el bigote?": rostro', 'me sacas el bigote?', { incluye: 'Depilación rostro' });
    caso('"limpieza de cutis"', 'quiero una limpieza de cutis', { incluye: 'Limpieza facial profunda' });
    caso('"tengo puntos negros"', 'tengo muchos puntos negros, que me recomendas?', { incluye: 'Limpieza facial profunda' });
    caso('"peling" mal escrito', 'cuanto sale el peling?', { incluye: ['Peeling', '$30000'] });
    caso('"tengo la espalda contracturada": masaje', 'tengo la espalda contracturada', { incluye: 'Masaje descontracturante' });
    caso('"drenaje linfatico"', 'quiero drenaje linfatico', { incluye: 'Drenaje linfático' });
    caso('"piernas hinchadas": drenaje', 'tengo las piernas hinchadas', { incluye: 'Drenaje linfático' });
  },

  almacen() {
    COMUNES();
    CLIENTE_DIFICIL();
    COMERCIO();
    COMERCIO_EN_PASO();
    console.log('\n— Almacén: pedidos —');
    caso('"pedido" + "dos cocas": pregunta cuál, y anota 2', ['pedido', 'dos cocas', '1'], { incluye: 'Anotado: 2 × Coca Cola 2,25 L' });
    caso('"media docena de huevos": los de 6', ['pedido', 'media docena de huevos'], { incluye: 'Anotado: 1 × Huevos x 6' });
    caso('"una docena de huevos": los de 12', ['pedido', 'una docena de huevos'], { incluye: 'Anotado: 1 × Huevos x 12' });
    caso('"7up" es un producto, no 7 unidades', ['pedido', '7up'], { incluye: 'Anotado: 1 × Seven Up' });
    caso('"9 de oro" es un producto, no 9 unidades', ['pedido', '9 de oro'], { incluye: 'Anotado: 1 × Galletitas 9 de Oro' });
    caso('"3 9 de oro": 3 paquetes', ['pedido', '3 9 de oro'], { incluye: 'Anotado: 3 × Galletitas 9 de Oro' });
    caso('"un fernet y 2 cocas": los dos', ['pedido', 'un fernet y 2 cocas'], { incluye: ['1 × Fernet', '¿Cuál de estos'] });
    caso('"alfajores x 3"', ['pedido', 'alfajores x 3'], { incluye: 'Anotado: 3 × Alfajor Jorgito' });
    caso('"un par de alfajores"', ['pedido', 'un par de alfajores'], { incluye: 'Anotado: 2 × Alfajor Jorgito' });
    console.log('\n— Almacén: lo que viene en paquete no se fracciona —');
    caso('"2 kg de yerba": 2 paquetes de 1 kg', ['pedido', '2 kg de yerba'], { incluye: 'Anotado: 2 × Yerba Playadito 1 kg' });
    caso('"medio kilo de yerba": viene en paquete', ['pedido', 'medio kilo de yerba'], { incluye: 'viene en paquete', no: '500 g' });
    caso('"1kg de pan" (pan suelto): 1 kg, con precio', ['pedido', '1kg de pan'], { incluye: 'Anotado: 1 kg de Pan francés — $2.500' });
  },

  kiosco() {
    COMUNES();
    CLIENTE_DIFICIL();
    COMERCIO();
    console.log('\n— Kiosco —');
    caso('"cuanto los marlboro"', 'cuanto los marlboro', { incluye: 'Cigarrillos Marlboro' });
    caso('"un atado de puchos"', 'un atado de puchos', { incluye: 'Cigarrillos Marlboro' });
    caso('"tenes algun alfajor?"', 'tenes algun alfajor?', { incluye: 'Alfajor Jorgito' });
  },

  fiambreria() {
    COMUNES();
    CLIENTE_DIFICIL();
    COMERCIO();
    console.log('\n— Fiambrería: lo que se pesa —');
    caso('"cuanto esta el jamon?": el precio por kilo', 'cuanto esta el jamon?', { incluye: 'Jamón cocido Paladini — $15.000 el kilo' });
    caso('"1/4 de jamon": 250 g, con precio', ['pedido', '1/4 de jamon'], { incluye: 'Anotado: 250 g de Jamón cocido Paladini — $3.750' });
    caso('"un cuarto de jamon"', ['pedido', 'un cuarto de jamon'], { incluye: '250 g de Jamón cocido Paladini' });
    caso('"200 de jamon"', ['pedido', '200 de jamon'], { incluye: '200 g de Jamón cocido Paladini — $3.000' });
    caso('"200 jamon" (como en la caja): 200 g', ['pedido', '200 jamon'], { incluye: '200 g de Jamón cocido Paladini' });
    caso('"medio de cremoso"', ['pedido', 'medio de cremoso'], { incluye: '500 g de Queso cremoso — $4.500' });
    caso('"medio cremoso"', ['pedido', 'medio cremoso'], { incluye: '500 g de Queso cremoso' });
    caso('"medio de queso barra"', ['pedido', 'medio de queso barra'], { incluye: '500 g de Queso barra — $5.500' });
    caso('"200 gramos de queso cremoso"', ['pedido', '200 gramos de queso cremoso'], { incluye: '200 g de Queso cremoso' });
    caso('"300g de jamon cocido"', ['pedido', '300g de jamon cocido'], { incluye: '300 g de Jamón cocido Paladini' });
    caso('"kilo y medio de cremoso"', ['pedido', 'kilo y medio de cremoso'], { incluye: '1,5 kg de Queso cremoso — $13.500' });
    caso('"medio kilo de queso": cuál queso, y el peso se mantiene', ['pedido', 'medio kilo de queso', '1'], { incluye: '500 g de Queso barra' });
    caso('"jamon" sin cuánto: pregunta, con el precio por kilo', ['pedido', 'jamon'], { incluye: ['¿Cuánto *Jamón cocido Paladini* querés?', '$15.000 el kilo'], estado: 'eligiendo_peso' });
    caso('y "1/4" lo anota', ['pedido', 'jamon', '1/4'], { incluye: '250 g de Jamón cocido Paladini' });
    caso('y "200" son gramos', ['pedido', 'jamon', '200'], { incluye: '200 g de Jamón' });
    caso('y "1" es un kilo', ['pedido', 'jamon', '1'], { incluye: '1 kg de Jamón' });
    caso('"2 jamon": 2 qué, pregunta', ['pedido', '2 jamon'], { incluye: '¿Cuánto *Jamón' });
    caso('varios renglones de mostrador', ['pedido', '1/4 de jamon\n200 de salame\nmedio de cremoso'],
      { incluye: ['250 g de Jamón cocido', '200 g de Salame Milán', '500 g de Queso cremoso'] });
    caso('"1/4 de jamon y 2 cocas": el jamón, y pregunta qué coca', ['pedido', '1/4 de jamon y 2 cocas'], { incluye: ['250 g', '¿Cuál de estos'] });
    caso('"jamon, 2 alfajores": pregunta cuánto jamón y sigue con los alfajores', ['pedido', 'jamon, 2 alfajores', '1/4'],
      { incluye: ['250 g de Jamón', '2 × Alfajor'] });
    caso('el resumen suma lo pesado con su precio', ['pedido', '1/4 de jamon', 'alfajor', 'listo', 'Sofi'],
      { incluye: ['250 g de Jamón cocido Paladini — $3.750', '1 × Alfajor Jorgito — $900', 'Total aproximado: $4.650', 'puede variar'] });
    caso('al confirmar, lo pesado va en gramos',
      ['pedido', '1/4 de jamon', 'alfajor', 'listo', 'Sofi', '1'], { incluye: 'Le pasé tu pedido',
        y: () => { const p = qPedidos.porEnviar().pop(); return p && p.datos.items.some((x) => x.gid && x.gramos === 250) && p.datos.items.some((x) => x.cantidad === 1); } });
    console.log('\n— Fiambrería: el pedido entero en el primer mensaje (prueba real, 2026-10-09) —');
    caso('"hola me podés cortar 200 de jamón, 1/4 de queso barra y 100 de salame?"', 'hola me podés cortar 200 de jamón, 1/4 de queso barra y 100 de salame?',
      { incluye: ['200 g de Jamón cocido Paladini', '250 g de Queso barra', '100 g de Salame Milán', '¿Algo más?'], estado: 'armando_pedido' });
    caso('"hola me cortás medio de cremoso y 150 de mortadela porfa"', 'hola me cortás medio de cremoso y 150 de salame porfa',
      { incluye: ['500 g de Queso cremoso', '150 g de Salame Milán'] });
    caso('"Buenas! me preparás 300 de jamón cocido, medio de queso y 2 cocas? gracias": anota, pregunta qué queso y sigue',
      ['Buenas! me preparás 300 de jamón cocido, medio de queso y 2 cocas? gracias', '1', '1', 'listo', 'Sofi'],
      { incluye: ['300 g de Jamón cocido Paladini', '500 g de Queso barra', '2 × Coca Cola 2,25 L'] });
    caso('"¿me cortás jamón y queso?" sin cantidades: pregunta cuánto de cada uno', 'me cortás jamón y queso?', { incluye: '¿Cuánto *Jamón cocido Paladini*', estado: 'eligiendo_peso' });
    caso('"¿cuánto sale 1/4 de jamón?": lo que sale ese peso, sin arrancar un pedido', 'cuanto sale 1/4 de jamon?', { incluye: '250 g de Jamón cocido Paladini — $3.750', estado: 'inicio' });
    caso('"¿tienen salame?" sigue siendo una consulta', 'tienen salame?', { incluye: 'Salame Milán — $20.000 el kilo', estado: 'inicio' });
    caso('solo cosas pesadas: igual se puede pedir', ['pedido', '1/4 de jamon', 'listo', 'Sofi'], { incluye: ['250 g de Jamón', '*1* — Confirmar'] });
  },
};

function COMERCIO() {
  console.log('\n— Comercio: consultas —');
  caso('"hay birra?"', 'hay birra?', { incluye: 'Cerveza Quilmes' });
  caso('"tenes cocacola?"', 'tenes cocacola?', { incluye: 'Coca Cola 2,25 L' });
  caso('"precio de la gaseosa"', 'precio de la gaseosa', { incluye: 'Coca Cola' });
  caso('"a cuanto esta el pan"', 'a cuanto esta el pan', { incluye: 'Pan francés' });
  caso('"panes?" (plural)', 'panes?', { incluye: 'Pan francés' });
  caso('"alfajores?" (plural)', 'alfajores?', { incluye: 'Alfajor Jorgito' });
  caso('"tienen puchos?"', 'tienen puchos?', { incluye: 'Cigarrillos Marlboro' });
  caso('"dos cocas" (sin decir pedido): las cocas', 'dos cocas', { incluye: 'Coca Cola' });
  caso('"papel higienico"', 'tenes papel higienico?', { incluye: 'Higienol' });
  caso('"tenes yerva?" (con v)', 'tenes yerva?', { incluye: 'Yerba Playadito' });
  caso('"jamon kosido" (como suena)', 'precio del jamon kosido', { incluye: 'Jamón cocido Paladini' });
  caso('"TENES COCA" en mayúsculas', 'TENES COCA', { incluye: 'Coca Cola' });
  caso('"hay coca de 1,5?": la de 1,5 L', 'hay coca de 1,5?', { incluye: 'Coca Cola Zero 1,5 L', no: '2,25' });
  caso('"tenes queso? alguien me atiende": el queso y la opción de una persona', 'tenes queso? alguien me atiende', { incluye: ['Queso cremoso', 'escribí *4*'], sinAviso: true });
  caso('pedido "jamon y queso" (se pesan): cuánto jamón primero, después cuál queso', ['pedido', 'jamon y queso', '1/4'], { incluye: ['250 g de Jamón cocido', '¿Cuál de estos', 'Queso cremoso'] });
  caso('pedido "fernet y alfajor": los dos', ['pedido', 'fernet y alfajor'], { incluye: ['1 × Fernet', '1 × Alfajor'] });
  caso('pedido "2 alfajores y una coca zero": los dos', ['pedido', '2 alfajores y una coca zero'], { incluye: ['2 × Alfajor', '1 × Coca Cola Zero'] });
  caso('"alguien me atiende? quiero saber si tienen leche": la leche, sin pasar a una persona',
    'alguien me atiende? quiero saber si tienen leche', { incluye: 'Leche La Serenísima', sinAviso: true });
  caso('"alguien me atiende?" a secas: pasa a una persona', 'alguien me atiende?', { aviso: true });
  caso('"hacen envios?": se retira en el local', 'hacen envios?', { incluye: 'retirar en el local' });
  caso('"mandan a domicilio?": se retira en el local', 'mandan a domicilio?', { incluye: 'retirar en el local' });
  caso('"estan abiertos?": horarios', 'estan abiertos?', { incluye: 'Horarios' });
  caso('"hasta que hora estan?": horarios', 'hasta que hora estan?', { incluye: 'Horarios' });
  caso('"hay sushi?": no encontré, y queda anotado', 'hay sushi?', { incluye: 'No encontré' });
  const r = motor.procesarMensaje({ de: config.numero_duena, texto: 'qué no entendiste' }).map((s) => s.texto).join('\n');
  if (r.includes('sushi')) console.log('  ✔ "qué no entendiste": el dueño ve "hay sushi?"');
  else { fallas++; console.log(`  ✘ FALLÓ: "qué no entendiste" no muestra lo del sushi → ${r.slice(0, 200)}`); }
}

console.log(`\n═══ ${config.negocio.rubro} ═══`);
PRUEBAS[rubro]();
console.log(fallas ? `\n❌ ${rubro}: ${fallas} frases fallaron` : `\n✅ ${rubro}: todas las frases OK`);
process.exit(fallas ? 1 : 0);
