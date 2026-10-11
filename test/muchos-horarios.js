// Un día con muchos horarios libres (El dueño, 2026-10-11: "que si hay muchos horarios disponibles no se mande una lista de
// 60 opciones"): nunca más de 10 en la lista, repartidos en el día; escribir otra hora libre, "a la tarde" o una hora ocupada
// sigue andando.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot_horarios_'));
process.env.RUTA_DB = path.join(DIR, 'turnos.db');

const { armar, ejemplo } = require('../src/config');
const base = ejemplo();
base.turnos.intervalo_slot_min = 15; // de 9 a 20 cada 15 minutos: más de 40 horarios por día
const config = armar(base);
const db = require('../src/db');
db.abrir(process.env.RUTA_DB);
db.sembrarServicios(config.servicios);
const { crearMotor } = require('../src/core/motor');
const agenda = require('../src/core/agenda');
const qServicios = require('../src/db/consultas/servicios');
const qClientas = require('../src/db/consultas/clientas');

const motor = crearMotor(config);
let fallas = 0;
const chequear = (n, c) => { if (c) console.log(`  ✔ ${n}`); else { console.log(`  ✘ FALLÓ: ${n}`); fallas++; } };
const decir = (de, texto) => motor.procesarMensaje({ de, texto }).filter((s) => s.para === de).map((s) => s.texto).join('\n');
const opciones = (t) => (t.match(/^\*\d+\* — /gm) || []).length;

const servicio = qServicios.porId(1);
// Un día con el local abierto todo el día y mucho lugar.
const dia = agenda.diasDisponibles(config, servicio).find((d) => agenda.horariosLibres(config, servicio, d, 0).length > 30);
chequear('hay un día con más de 30 horarios libres para probar', !!dia);
const [, mes, dd] = dia.split('-').map(Number);
const libres = agenda.horariosLibres(config, servicio, dia, 0);

function hastaLaHora(quien) {
  decir(quien, 'hola');
  decir(quien, '1');
  decir(quien, '1');
  return decir(quien, `${dd}/${mes}`);
}

const C1 = '5492944500001';
let t = hastaLaHora(C1);
chequear('la lista de horarios no pasa de 10', opciones(t) > 0 && opciones(t) <= 10);
const enPunto = libres.filter((h) => h.endsWith(':00'));
chequear('van en punto, del primero al último del día', t.includes(`*1* — ${enPunto[0]}`) && t.includes(`— ${enPunto[enPunto.length - 1]}`) && !/— \d\d:(15|30|45)/.test(t));
chequear('dice que puede escribir otro horario o la parte del día', t.includes('escribilo') && t.includes('a la tarde'));

const fuera = libres.find((h) => !h.endsWith(':00'));
t = decir(C1, fuera);
chequear(`una hora libre que no estaba en la lista (${fuera}) se toma igual`, t.includes('nombre') && qClientas.porTelefono(C1).estado_conv === 'pidiendo_nombre');

const C2 = '5492944500002';
hastaLaHora(C2);
t = decir(C2, 'a la tarde');
chequear('"a la tarde": solo horarios de la tarde, sin pasar de 10', opciones(t) > 0 && opciones(t) <= 10 && !/— 09:00/.test(t) && /— 1[5-9]:/.test(t));
chequear('sigue eligiendo la hora', qClientas.porTelefono(C2).estado_conv === 'eligiendo_hora');
t = decir(C2, '1');
chequear('el número elige de la lista nueva (la de la tarde)', t.includes('nombre'));
const datos = JSON.parse(qClientas.porTelefono(C2).datos_conv);
chequear('y la hora elegida es de la tarde', datos.hora >= '12:30');

// Una hora ocupada: las más cercanas, no la lista entera.
const C3 = '5492944500003';
hastaLaHora(C3);
qClientas.guardarEstado(qClientas.porTelefono(C3).id, 'eligiendo_hora', { ...JSON.parse(qClientas.porTelefono(C3).datos_conv), libres: libres.filter((h) => h !== '14:00') });
t = decir(C3, 'a las 14');
chequear('pidió una hora ocupada: le ofrece las más cercanas', t.includes('Lo más cerca') && /— 13:45/.test(t) && /— 14:15/.test(t) && opciones(t) <= 6);

console.log(fallas ? `\n❌ ${fallas} chequeos de muchos horarios fallaron` : '\n✅ Muchos horarios OK');
process.exit(fallas ? 1 : 0);
