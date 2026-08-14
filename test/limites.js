// Suite 3: bordes de agenda, persistencia del estado y consistencia de datos.
// Lo que no se ve en el flujo feliz pero rompe en producción.
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUTA_DB = path.join(os.tmpdir(), `test_lim_${Date.now()}.db`);
process.env.RUTA_DB = RUTA_DB;

const config = JSON.parse(JSON.stringify(require('../config.json')));
const db = require('../src/db');
db.abrir(RUTA_DB);
db.sembrarServicios(config.servicios);

const { crearMotor } = require('../src/core/motor');
const recordatorios = require('../src/core/recordatorios');
const agenda = require('../src/core/agenda');
const fechas = require('../src/core/fechas');
const qServicios = require('../src/db/consultas/servicios');
const qTurnos = require('../src/db/consultas/turnos');
const qClientas = require('../src/db/consultas/clientas');

const motor = crearMotor(config);
const DUENA = config.numero_duena;
let fallas = 0, n = 0;
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
// Próximo día de la semana pedido (0=domingo), a partir de mañana
function proximo(diaSemana) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  do { d.setDate(d.getDate() + 1); } while (d.getDay() !== diaSemana);
  return fechas.aTexto(d).slice(0, 10);
}
let r;

console.log('— K. Bordes de la agenda —');
const semi = qServicios.porId(1);   // 60 min
const softgel = qServicios.porId(3); // 90 min
chequear('domingo (cerrado en config) no ofrece horarios',
  agenda.horariosLibres(config, semi, proximo(0)).length === 0);

const sab = proximo(6); // sábado 10:00–14:00
const libresSab = agenda.horariosLibres(config, semi, sab);
chequear('sábado corto: primer slot 10:00', libresSab[0] === '10:00');
chequear('sábado corto: último slot de 60 min es 13:00 (termina 14:00)',
  libresSab[libresSab.length - 1] === '13:00');
const libresSabLargo = agenda.horariosLibres(config, softgel, sab);
chequear('servicio de 90 min: último slot 12:30 (termina 14:00)',
  libresSabLargo[libresSabLargo.length - 1] === '12:30');
chequear('ningún slot pasa del cierre',
  libresSabLargo.every((h) => fechas.sumarMinutos(`${sab} ${h}`, 90) <= `${sab} 14:00`));

// Anticipación mínima: 2 hs (config). Hoy nunca debe ofrecer algo ya pasado.
const hoy = fechas.hoyYmd();
const minimo = fechas.aTexto(new Date(Date.now() + config.turnos.anticipacion_minima_horas * 3600000));
chequear('hoy no ofrece horarios dentro de las próximas 2 hs',
  agenda.horariosLibres(config, semi, hoy).every((h) => `${hoy} ${h}` >= minimo));

const lejos = fechas.aTexto(new Date(Date.now() + 60 * 86400000)).slice(0, 10);
chequear('no hay días disponibles más allá del límite configurado',
  !agenda.diasDisponibles(config, semi).includes(lejos));

console.log('— L. Persistencia del estado (reinicio del bot a mitad de flujo) —');
const C1 = '5492944003001';
decir(C1, 'hola'); decir(C1, '1'); decir(C1, '1'); // quedó en eligiendo_dia
const guardada = qClientas.porTelefono(C1);
chequear('el estado se guardó en la DB', guardada.estado_conv === 'eligiendo_dia');
chequear('los datos parciales también', JSON.parse(guardada.datos_conv).servicioId === 1);
// Simulamos reinicio: motor nuevo, lee el estado de la DB
const motor2 = crearMotor(config);
r = motor2.procesarMensaje({ de: C1, texto: '1' });
chequear('después del reinicio sigue donde estaba', txt(r, C1).includes('horarios libres'));

const C2 = '5492944003002';
decir(C2, 'hola'); decir(C2, '1');
db.obtener().prepare("UPDATE clientas SET datos_conv = 'esto no es json' WHERE telefono = ?").run(C2);
let rompio = false;
try { r = decir(C2, '1'); } catch { rompio = true; }
chequear('datos_conv corrupto no tumba el bot', !rompio);

console.log('— M. Cambios de configuración a mitad de flujo —');
const C3 = '5492944003003';
decir(C3, 'hola'); decir(C3, '1'); decir(C3, '2'); // eligió Kapping
db.obtener().prepare('UPDATE servicios SET activo = 0 WHERE id = 2').run();
r = decir(C3, '1'); // sigue eligiendo día del servicio ya desactivado
chequear('servicio desactivado a mitad de flujo no rompe', Array.isArray(r) && r.length > 0);
db.obtener().prepare('UPDATE servicios SET activo = 1 WHERE id = 2').run();

const C4 = '5492944003004';
decir(C4, 'hola'); decir(C4, '1'); decir(C4, '1');
decir(C4, '1'); decir(C4, '1'); decir(C4, 'Dana');
decir(DUENA, '!precio 1 99000'); // la dueña cambia el precio mientras charlan
r = decir(C4, '1'); // confirma
chequear('cambio de precio a mitad de flujo no rompe la reserva',
  txt(r, C4).includes('seña') || txt(r, C4).includes('confirmado'));
decir(DUENA, '!precio 1 18000');

console.log('— N. Derivación a humano: entra y sale —');
const C5 = '5492944003005';
decir(C5, 'hola');
decir(C5, 'necesito hablar con alguien');
chequear('quedó derivada', qClientas.estaDerivada(qClientas.porTelefono(C5)));
r = decir(C5, 'hola?');
chequear('el bot no contesta mientras está derivada', r.length === 0);
// Vencemos la derivación a mano (pasaron las 12 hs)
db.obtener().prepare("UPDATE clientas SET derivada_hasta = '2020-01-01 00:00' WHERE telefono = ?").run(C5);
r = decir(C5, 'hola');
chequear('cuando vence la derivación vuelve a atender', txt(r, C5).includes('¿Qué necesitás?'));

console.log('— O. Fotos y comprobantes fuera de lugar —');
const C6 = '5492944003006';
decir(C6, 'hola');
r = decir(C6, null, { ...foto('Transferencia $ 5.000 operación 555555') });
chequear('foto sin turno pendiente no rompe ni descuenta nada', Array.isArray(r));
chequear('no se creó ninguna seña fantasma',
  db.obtener().prepare('SELECT COUNT(*) n FROM senas WHERE nro_operacion = ?').get('555555').n === 0);

// Dos fotos seguidas para el mismo turno
const C7 = '5492944003007';
decir(C7, 'hola'); decir(C7, '1'); decir(C7, '1'); decir(C7, '1');
decir(C7, '1'); decir(C7, 'Eva'); decir(C7, '1');
decir(C7, null, { ...foto('Transferencia $ 5.000 Para Maria Ejemplo operación 777001') });
r = decir(C7, null, { ...foto('Transferencia $ 5.000 Para Maria Ejemplo operación 777002') });
chequear('segunda foto sobre turno ya confirmado no duplica turnos',
  db.obtener().prepare("SELECT COUNT(*) n FROM turnos t JOIN clientas c ON c.id=t.clienta_id WHERE c.telefono=? AND t.estado IN ('pendiente_sena','confirmado')").get(C7).n === 1);

console.log('— P. Recordatorios: los que NO deben salir —');
db.obtener().prepare("UPDATE turnos SET recordatorio_enviado = 1").run(); // limpiamos ruido previo
const C8 = '5492944003008';
decir(C8, 'hola'); decir(C8, '1'); decir(C8, '1'); decir(C8, '1');
decir(C8, '1'); decir(C8, 'Fer'); decir(C8, '1'); // queda pendiente_sena
const salientes = recordatorios.tick(config);
chequear('turno pendiente de seña NO recibe recordatorio',
  !salientes.some((s) => s.para === C8 && s.texto.includes('recordamos')));

// Turno cancelado tampoco
const idCancel = db.obtener().prepare(
  "SELECT t.id FROM turnos t JOIN clientas c ON c.id=t.clienta_id WHERE c.telefono=? ORDER BY t.id DESC LIMIT 1"
).get(C8).id;
qTurnos.cambiarEstado(idCancel, 'cancelado');
db.obtener().prepare('UPDATE turnos SET recordatorio_enviado = 0 WHERE id = ?').run(idCancel);
chequear('turno cancelado NO recibe recordatorio',
  !recordatorios.tick(config).some((s) => s.para === C8 && s.texto.includes('recordamos')));

// Turno muy lejano tampoco (fuera de la ventana de 24 hs)
const lejano = fechas.aTexto(new Date(Date.now() + 5 * 86400000));
db.obtener().prepare(`
  UPDATE turnos SET inicio = ?, fin = ?, estado = 'confirmado', recordatorio_enviado = 0 WHERE id = ?
`).run(lejano, fechas.sumarMinutos(lejano, 60), idCancel);
chequear('turno a 5 días NO recibe recordatorio todavía',
  !recordatorios.tick(config).some((s) => s.para === C8 && s.texto.includes('recordamos')));

console.log('— Q. Agenda vacía y comandos sobre la nada —');
db.obtener().prepare("UPDATE turnos SET estado = 'cancelado'").run();
r = decir(DUENA, '!hoy');
chequear('!hoy sin turnos avisa lindo', txt(r, DUENA).includes('Sin turnos'));
r = decir(DUENA, '!semana');
chequear('!semana sin turnos avisa lindo', txt(r, DUENA).includes('Sin turnos'));
const C9 = '5492944003009';
decir(C9, 'hola');
r = decir(C9, 'confirmo');
chequear('CONFIRMO sin turno no rompe', Array.isArray(r) && r.length > 0);
r = decir(C9, 'quiero cancelar');
chequear('cancelar sin turno avisa que no hay nada', txt(r, C9).includes('No encontré'));

console.log('— R. Nombres raros —');
const C11 = '5492944003011';
decir(C11, 'hola'); decir(C11, '1'); decir(C11, '1'); decir(C11, '1'); decir(C11, '1');
r = decir(C11, '💅✨');
chequear('nombre de solo emojis: repregunta', txt(r, C11).includes('nombre'));
r = decir(C11, 'M');
chequear('nombre de 1 letra: repregunta', txt(r, C11).includes('nombre'));
r = decir(C11, 'María José Fernández de la Torre');
chequear('nombre largo válido lo acepta', txt(r, C11).includes('María José'));

console.log(`\n${fallas === 0 ? `✅ ${n} chequeos OK` : `❌ ${fallas} de ${n} fallaron`}`);
fs.unlinkSync(RUTA_DB);
process.exit(fallas === 0 ? 0 : 1);
