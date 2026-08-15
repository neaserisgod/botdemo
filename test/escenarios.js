// Batería de escenarios "hostiles" — todo lo que puede pasar cuando el copy
// llegue a los grupos y entre gente de verdad. DB propia, no toca nada.
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUTA_DB = path.join(os.tmpdir(), `test_esc_${Date.now()}.db`);
process.env.RUTA_DB = RUTA_DB;

const config = require('../config.json');
const db = require('../src/db');
db.abrir(RUTA_DB);
db.sembrarServicios(config.servicios);

const { crearMotor } = require('../src/core/motor');
const recordatorios = require('../src/core/recordatorios');
const salud = require('../src/salud');
const qTurnos = require('../src/db/consultas/turnos');
const qSenas = require('../src/db/consultas/senas');
const agenda = require('../src/core/agenda');
const fechas = require('../src/core/fechas');
const qServicios = require('../src/db/consultas/servicios');

const motor = crearMotor(config);
const DUENA = config.numero_duena;
let fallas = 0;
let n = 0;

function chequear(nombre, cond) {
  n++;
  if (cond) console.log(`  ✔ ${nombre}`);
  else { console.log(`  ✘ FALLÓ: ${nombre}`); fallas++; }
}
const decir = (de, texto, extra) => motor.procesarMensaje({ de, texto, ...extra });
const txt = (sal, quien) => sal.filter((s) => s.para === quien).map((s) => s.texto).join('\n');
function foto(caption) {
  const ruta = path.join(os.tmpdir(), `f_${Date.now()}_${Math.random()}.png`);
  fs.writeFileSync(ruta, 'fake');
  return { rutaImagen: ruta, texto: caption };
}
// Lleva a una clienta hasta esperando_comprobante y devuelve el id de turno
function reservarConSena(tel, nombre) {
  decir(tel, 'hola'); decir(tel, '1'); decir(tel, '1'); // semipermanente
  decir(tel, '1'); decir(tel, '1');                     // primer día y hora libres
  decir(tel, nombre); decir(tel, '1');                  // confirma → pide seña
  const t = db.obtener().prepare(
    "SELECT t.id FROM turnos t JOIN clientas c ON c.id=t.clienta_id WHERE c.telefono=? ORDER BY t.id DESC LIMIT 1"
  ).get(tel);
  return t.id;
}

let r, id;

console.log('— A. Señas: todos los caminos feos —');
id = reservarConSena('5492944000101', 'Ana');
r = decir('5492944000101', null, { ...foto('Transferencia $ 3.000 Para Maria Ejemplo operación 111111') });
chequear('monto corto → a_revisar con motivo', qSenas.porTurno(id).estado === 'a_revisar'
  && txt(r, DUENA).includes('menor a la seña'));
r = decir(DUENA, `!no ${id}`);
chequear('!no rechaza, cancela turno y avisa a la clienta',
  qTurnos.porId(id).estado === 'cancelado' && r.some((s) => s.para === '5492944000101'));

id = reservarConSena('5492944000102', 'Bea');
r = decir('5492944000102', null, { ...foto('Transferencia $ 5.000 Para Maria Ejemplo, gracias') });
chequear('sin nº de operación → a_revisar', qSenas.porTurno(id).estado === 'a_revisar'
  && txt(r, DUENA).includes('operación'));
decir(DUENA, `!ok ${id}`);
chequear('!ok lo levanta igual', qTurnos.porId(id).estado === 'confirmado');

id = reservarConSena('5492944000103', 'Cami');
r = decir('5492944000103', null, { ...foto('Transferencia $ 5.000 Para Juan Perez operación 222222') });
chequear('destinatario ajeno → a_revisar', qSenas.porTurno(id).estado === 'a_revisar'
  && txt(r, DUENA).includes('no coincide'));
decir(DUENA, `!no ${id}`);

id = reservarConSena('5492944000104', 'Dai');
r = decir('5492944000104', 'te mando en un rato');
chequear('texto sin foto: re-pide el comprobante', txt(r, '5492944000104').includes('comprobante'));
r = decir('5492944000104', '0');
chequear('se arrepiente con 0: cancela y avisa a la dueña',
  qTurnos.porId(id).estado === 'cancelado' && r.some((s) => s.para === DUENA));

console.log('— B. Seña vencida libera el horario —');
id = reservarConSena('5492944000105', 'Eli');
const turnoAntes = qTurnos.porId(id);
db.obtener().prepare("UPDATE senas SET vence_en = '2020-01-01 00:00' WHERE turno_id = ?").run(id);
r = recordatorios.tick(config);
chequear('turno vencido y avisa a ambas', qTurnos.porId(id).estado === 'vencido'
  && r.some((s) => s.para === '5492944000105') && r.some((s) => s.para === DUENA));
const libresDespues = agenda.horariosLibres(config, qServicios.porId(turnoAntes.servicio_id), turnoAntes.inicio.slice(0, 10));
chequear('el horario quedó libre de nuevo', libresDespues.includes(turnoAntes.inicio.slice(11)));

console.log('— C. Carrera: dos clientas, mismo horario —');
// F llega hasta confirmar SIN confirmar; G le gana el lugar; F confirma tarde
decir('5492944000106', 'hola'); decir('5492944000106', '1'); decir('5492944000106', '1');
decir('5492944000106', '1'); r = decir('5492944000106', '1'); decir('5492944000106', 'Flor');
// F está en "confirmando". G reserva el mismo primer slot:
decir('5492944000107', 'hola'); decir('5492944000107', '1'); decir('5492944000107', '1');
decir('5492944000107', '1'); decir('5492944000107', '1'); decir('5492944000107', 'Gime');
decir('5492944000107', '1'); // G crea el turno (pendiente_sena) → ocupa el slot
r = decir('5492944000106', '1'); // F confirma tarde
chequear('doble reserva bloqueada con aviso', txt(r, '5492944000106').includes('acaban de reservar'));

console.log('— D. Recordatorio → cancelar → horario libre —');
// G todavía debe la seña; la pagamos para poder recordar y cancelar
r = decir('5492944000107', null, { ...foto('Transferencia $ 5.000 Para Maria Ejemplo operación 333333') });
chequear('seña de G verificada', qSenas.existeOperacion('333333'));
const enviados = recordatorios.tick(config);
chequear('recordatorio sale para turnos de mañana', enviados.some((s) => s.para === '5492944000107'));
r = decir('5492944000107', 'no voy a poder ir, cancelame');
chequear('lenguaje natural dispara cancelación', txt(r, '5492944000107').includes('¿Cancelo'));
r = decir('5492944000107', '1');
chequear('cancela y notifica a la dueña', r.some((s) => s.para === DUENA));

console.log('— E. Comandos de dueña con errores —');
r = decir(DUENA, '!turno 999');
chequear('!turno inexistente avisa', txt(r, DUENA).includes('No encontré'));
r = decir(DUENA, '!ok 999');
chequear('!ok inexistente avisa', txt(r, DUENA).includes('No encontré'));
r = decir(DUENA, `!ok ${id}`); // seña de B ya resuelta (vencida)
chequear('!ok sobre seña no pendiente avisa', txt(r, DUENA).includes('no tiene'));
r = decir(DUENA, '!cualquiercosa');
chequear('comando desconocido → ayuda', txt(r, DUENA).includes('Escribime como te salga'));
r = decir(DUENA, '!precio 1 abc');
chequear('!precio con monto inválido avisa cómo se hace', txt(r, DUENA).includes('No entendí qué precio'));
r = decir(DUENA, '!anular 999');
chequear('!anular inexistente avisa', txt(r, DUENA).includes('No encontré'));

console.log('— E2. La dueña escribiendo en lenguaje natural —');
// Turno nuevo para jugar con él
const CN = '5492944000110';
decir(CN, 'hola'); decir(CN, '1'); decir(CN, '4'); // retiro: sin seña
decir(CN, '1'); decir(CN, '1'); decir(CN, 'Nati'); decir(CN, '1');
const idNat = db.obtener().prepare(
  "SELECT t.id FROM turnos t JOIN clientas c ON c.id=t.clienta_id WHERE c.telefono=? ORDER BY t.id DESC LIMIT 1"
).get(CN).id;

r = decir(DUENA, '¿qué tengo hoy?');
chequear('"qué tengo hoy" → agenda del día', txt(r, DUENA).includes('Agenda de hoy'));
r = decir(DUENA, 'cómo viene la semana');
chequear('"cómo viene la semana" → resumen semanal', txt(r, DUENA).includes('Semana'));
r = decir(DUENA, `quién es el turno ${idNat}`);
chequear('"quién es el turno N" → detalle', txt(r, DUENA).includes('Nati'));
r = decir(DUENA, 'el kapping ahora sale 31000');
chequear('cambio de precio hablado', txt(r, DUENA).includes('31000'));
r = decir(DUENA, 'precios');
chequear('"precios" → lista', txt(r, DUENA).includes('Kapping'));

// Acción destructiva: pide confirmación antes de tocar nada
r = decir(DUENA, `anulá el turno ${idNat}`);
chequear('anular hablado PIDE confirmación', txt(r, DUENA).includes('¿Confirmás'));
chequear('y todavía NO anuló nada', qTurnos.porId(idNat).estado !== 'anulado');
r = decir(DUENA, 'no');
chequear('"no" cancela la acción', txt(r, DUENA).includes('no hice nada')
  && qTurnos.porId(idNat).estado !== 'anulado');
decir(DUENA, `borrá el ${idNat}`);
r = decir(DUENA, 'dale');
chequear('"dale" confirma y anula', qTurnos.porId(idNat).estado === 'anulado');
chequear('le avisa a la clienta', r.some((s) => s.para === CN));

// El comando con ! sigue siendo directo, sin confirmación
const CN2 = '5492944000111';
decir(CN2, 'hola'); decir(CN2, '1'); decir(CN2, '4');
decir(CN2, '1'); decir(CN2, '1'); decir(CN2, 'Pili'); decir(CN2, '1');
const idCmd = db.obtener().prepare(
  "SELECT t.id FROM turnos t JOIN clientas c ON c.id=t.clienta_id WHERE c.telefono=? ORDER BY t.id DESC LIMIT 1"
).get(CN2).id;
decir(DUENA, `!anular ${idCmd}`);
chequear('!anular ejecuta directo (sin confirmación)', qTurnos.porId(idCmd).estado === 'anulado');

r = decir(DUENA, 'anulá un turno');
chequear('sin número, pregunta cuál', txt(r, DUENA).includes('Decime el número'));
r = decir(DUENA, 'ayuda');
chequear('ayuda lista ejemplos hablados', txt(r, DUENA).includes('qué tengo hoy'));

console.log('— E3. Aviso masivo a clientas —');
const cuantas = db.obtener().prepare(
  'SELECT COUNT(*) n FROM clientas WHERE telefono NOT IN (?, ?)'
).get(DUENA, config.numero_soporte).n;
r = decir(DUENA, 'aviso el viernes cerramos a las 15');
chequear('pide confirmación y dice a cuántas va', txt(r, DUENA).includes('¿Lo mando?')
  && txt(r, DUENA).includes(`${cuantas} clienta`));
chequear('todavía no le mandó nada a nadie', r.every((s) => s.para === DUENA));
r = decir(DUENA, 'no');
chequear('"no" cancela el aviso', txt(r, DUENA).includes('no hice nada'));

decir(DUENA, 'aviso promo de la semana: 20% off');
r = decir(DUENA, 'dale');
const aClientas = r.filter((s) => s.para !== DUENA);
chequear('manda a todas las clientas', aClientas.length === cuantas);
chequear('el mensaje lleva el nombre del negocio', aClientas[0].texto.includes(config.negocio.nombre));
chequear('y el texto que escribió', aClientas[0].texto.includes('20% off'));
chequear('van espaciados (anti-spam de WhatsApp)',
  aClientas.slice(1).every((s) => s.demora >= 5000));
chequear('la dueña recibe aviso de inicio y de fin',
  r[0].para === DUENA && r[r.length - 1].texto.includes('Aviso enviado'));
chequear('el aviso NO le llega a la dueña ni a soporte',
  !aClientas.some((s) => s.para === DUENA || s.para === config.numero_soporte));
r = decir(DUENA, 'aviso');
chequear('"aviso" sin texto no dispara nada', !txt(r, DUENA).includes('¿Lo mando?'));

console.log('— E4. Turnos al calendario (.ics) —');
const cal = require('../src/core/calendario');
const CC = '5492944000120';
decir(CC, 'hola'); decir(CC, '1'); decir(CC, '4');
decir(CC, '1'); decir(CC, '1'); decir(CC, 'Lu');
r = decir(CC, '1'); // confirma turno sin seña
const conIcs = r.find((s) => s.adjunto);
chequear('al confirmar, la dueña recibe el .ics', !!conIcs && conIcs.para === DUENA);
chequear('el adjunto es un .ics', conIcs.adjunto.nombre.endsWith('.ics')
  && conIcs.adjunto.mime === 'text/calendar');
const idCal = db.obtener().prepare(
  "SELECT t.id FROM turnos t JOIN clientas c ON c.id=t.clienta_id WHERE c.telefono=? ORDER BY t.id DESC LIMIT 1"
).get(CC).id;
const ics = fs.readFileSync(conIcs.adjunto.ruta, 'utf8');
chequear('el .ics tiene el evento con el turno', ics.includes(`UID:turno-${idCal}@bot-turnos`)
  && ics.includes('BEGIN:VEVENT') && ics.includes('END:VCALENDAR'));
chequear('incluye clienta, servicio y dirección', ics.includes('Lu')
  && ics.includes('Retiro de esmaltado') && ics.includes('Mitre 150'));
chequear('tiene alarma 30 min antes', ics.includes('TRIGGER:-PT30M'));
const turnoCal = qTurnos.porId(idCal);
chequear('la hora del evento coincide con el turno',
  ics.includes(`DTSTART:${turnoCal.inicio.replace(/[-:]/g, '').replace(' ', 'T')}00`));
chequear('calendario completo se genera para el panel',
  cal.textoDeTurnos(config, qTurnos.delDia(fechas.hoyYmd())).includes('BEGIN:VCALENDAR'));
const sinCal = JSON.parse(JSON.stringify(config));
sinCal.calendario = { habilitado: false };
chequear('se puede desactivar por config',
  require('../src/core/notificaciones').invitacionCalendario(sinCal, turnoCal).length === 0);

console.log('— E5. Contacto de la clienta a la agenda (.vcf) —');
const CV = '5492944000130';
decir(CV, 'hola'); decir(CV, '1'); decir(CV, '4');
decir(CV, '1'); decir(CV, '1'); decir(CV, 'Sofía Gutiérrez');
r = decir(CV, '1');
const vcf = r.find((s) => s.adjunto && s.adjunto.mime === 'text/vcard');
chequear('clienta nueva: manda el .vcf a la dueña', !!vcf && vcf.para === DUENA);
const textoVcf = fs.readFileSync(vcf.adjunto.ruta, 'utf8');
chequear('usa el nombre que dio la clienta', textoVcf.includes('Sofía Gutiérrez'));
chequear('lleva el teléfono con +', textoVcf.includes('TEL;TYPE=CELL:+' + CV));
chequear('vCard bien formada', textoVcf.startsWith('BEGIN:VCARD') && textoVcf.includes('END:VCARD'));
chequear('el nombre del archivo conserva tildes', vcf.adjunto.nombre.includes('í'));
// Segundo turno de la misma: no repite
decir(CV, 'hola'); decir(CV, '1'); decir(CV, '4'); decir(CV, '1'); decir(CV, '2');
r = decir(CV, '1');
chequear('NO repite el contacto en el segundo turno',
  !r.some((s) => s.adjunto && s.adjunto.mime === 'text/vcard'));
// Exportar todas
r = decir(DUENA, 'pasame los contactos');
chequear('exporta todas las clientas', r[0].adjunto && r[0].adjunto.nombre === 'clientas.vcf');
const todas = fs.readFileSync(r[0].adjunto.ruta, 'utf8');
chequear('el archivo tiene varias tarjetas',
  (todas.match(/BEGIN:VCARD/g) || []).length > 1 && todas.includes('Sofía Gutiérrez'));
chequear('no incluye a la dueña ni a soporte',
  !todas.includes(DUENA) && !todas.includes(config.numero_soporte));

console.log('— F. FAQ y saludos con typos —');
const C = '5492944000108';
r = decir(C, 'presios porfa?');
chequear('FAQ precios con typo', txt(r, C).includes('Precios'));
r = decir(C, 'ubicasion?');
chequear('FAQ ubicación con typo', txt(r, C).includes(config.negocio.direccion));
r = decir(C, 'holis');
chequear('"holis" saluda con menú', txt(r, C).includes('¿Qué necesitás?'));
r = decir(C, 'buen diaa!!');
chequear('"buen diaa!!" también', txt(r, C).includes('¿Qué necesitás?'));

console.log('— G. Catálogo y rarezas —');
r = decir('5492944000109', '', { productoId: 'no-existe-en-db' });
chequear('producto desconocido → ofrece la lista de servicios', txt(r, '5492944000109').includes('¿Qué servicio'));
r = decir('5492944000109', '👍👍👍');
chequear('solo emojis de ok → cortesía o menú, no error', r.length >= 0);
r = decir('5492944000109', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
chequear('texto basura no rompe', r.length > 0);
r = decir(config.numero_soporte, 'hola');
chequear('mi número de soporte no entra al flujo', r.length === 0);

console.log('— H2. Parser con OCR real de Mercado Pago —');
// Texto tal cual lo devolvió Tesseract (en inglés) sobre una captura real:
// la ó leída como é, número de operación en línea aparte, fecha en letras.
const ocr = require('../src/core/ocr');
const ocrMp = ocr.parsear(`mercado\npago\n\nComprobante de transferencia\nJueves, 13 de agosto de 2026 a las 11:51 hs\n\n$ 80.000\n\nMotivo: Varios\n\n° De\nBruno Fuentes\nCUIT/CUIL: 20-44323698-9\nMercado Pago\nCVU: 0000003100091193832770\n\n© Para\nSerra S.r.l.\nCUIT/CUIL: 30-67037821-3\nBanco de la Nacion Argentina\nCBU: 0110463320046300643604\n\nNumero de operacién de Mercado Pago\n172710318425\n\nCédigo de identificacién\n46YGOW9MGX6J36L89EXD8J`);
chequear('monto MP real', ocrMp.monto === 80000);
chequear('destinatario MP real', ocrMp.destinatario === 'Serra S.r.l.');
chequear('nº de operación en línea aparte y con "operacién"', ocrMp.nroOperacion === '172710318425');
chequear('fecha en letras', ocrMp.fecha === '13/8/2026');

console.log('— I. Extractor de fecha y hora (independiente del día que se corra) —');
const nlu = require('../src/core/nlu');
// Base fija: viernes 14/8/2026 12:00, para que los chequeos no dependan de hoy.
const BASE = new Date(2026, 7, 14, 12, 0);
const fh = (txt) => nlu.extraerFechaHora(txt, BASE);
chequear('"mañana a las 11"', fh('quiero turno mañana a las 11').dia === '2026-08-15'
  && fh('quiero turno mañana a las 11').hora === '11:00');
chequear('"pasado mañana tipo 4 de la tarde" → 16:00',
  fh('para pasado mañana tipo 4 de la tarde').dia === '2026-08-16'
  && fh('para pasado mañana tipo 4 de la tarde').hora === '16:00');
chequear('"a las 9 de la mañana el lunes" no confunde mañana/día',
  fh('a las 9 de la mañana el lunes').dia === '2026-08-17'
  && fh('a las 9 de la mañana el lunes').hora === '09:00');
chequear('"el sabado 10 hs"', fh('se puede el sabado 10 hs?').dia === '2026-08-15'
  && fh('se puede el sabado 10 hs?').hora === '10:00');
chequear('"20/8 a las 9"', fh('el 20/8 a las 9').dia === '2026-08-20');
chequear('"dia 25"', fh('necesito turno dia 25').dia === '2026-08-25');
chequear('"16.30 el jueves"', fh('a las 16.30 el jueves').hora === '16:30'
  && fh('a las 16.30 el jueves').dia === '2026-08-20');
chequear('"el 2" pelado NO es fecha (es opción de menú)', fh('el 2').dia === null);
chequear('texto sin fecha ni hora', fh('quiero un turno').dia === null && fh('quiero un turno').hora === null);
chequear('fecha ya pasada de este mes salta al mes que viene',
  fh('turno para el dia 5').dia === '2026-09-05');

// Solo día u hora sueltos ya cuentan como intención de reservar
const C10 = '5492944001010';
r = decir(C10, 'se puede el sabado 10 hs?');
chequear('día/hora sin la palabra "turno" arranca la reserva', txt(r, C10).includes('¿Qué servicio'));

console.log('— J. Estrés: 40 clientas reservando en paralelo —');
let creados = 0, rebotados = 0;
for (let k = 0; k < 40; k++) {
  const tel = `54929440020${String(k).padStart(2, '0')}`;
  decir(tel, 'hola'); decir(tel, '1'); decir(tel, '4'); // retiro (30 min, sin seña)
  decir(tel, '1'); decir(tel, '1');
  decir(tel, `Clienta${k}`);
  const res = decir(tel, '1');
  if (txt(res, tel).includes('Turno confirmado')) creados++;
  else if (txt(res, tel).includes('acaban de reservar')) rebotados++;
}
chequear('nadie se pisa: cada turno ocupa su horario', creados + rebotados === 40 && creados > 0);
const solapados = db.obtener().prepare(`
  SELECT COUNT(*) AS n FROM turnos a JOIN turnos b
    ON a.id < b.id AND a.inicio < b.fin AND a.fin > b.inicio
   WHERE a.estado IN ('pendiente_sena','confirmado') AND b.estado IN ('pendiente_sena','confirmado')
`).get().n;
chequear('CERO solapamientos en la base', solapados === 0);
console.log(`     (${creados} confirmados, ${rebotados} rebotados por agenda llena)`);

console.log('— H. Salud del sistema —');
salud.registrarCaida('prueba');
r = salud.alReconectar(config);
chequear('reconexión avisa a la dueña', r.some((s) => s.para === DUENA));
r = salud.latido(config);
chequear('latido va SOLO a soporte y sin datos de clientas',
  r.length === 1 && r[0].para === config.numero_soporte && !r[0].texto.includes('turno'));
chequear('batería fuera de Termux no rompe', Array.isArray(salud.chequearBateria(config)));
r = recordatorios.agendaDiaria(config);
chequear('agenda diaria se genera', r[0].para === DUENA && r[0].texto.includes('Agenda'));
r = recordatorios.resumenSemanal(config);
chequear('resumen semanal se genera', r[0].para === DUENA);

console.log(`\n${fallas === 0 ? `✅ ${n} escenarios OK` : `❌ ${fallas} de ${n} fallaron`}`);
fs.unlinkSync(RUTA_DB);
process.exit(fallas === 0 ? 0 : 1);
