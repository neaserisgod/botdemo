// Asincrónico: el motor devuelve promesas (la conversación de turnos espera la red al reservar, etapa 5 de Nodo Sur).
(async () => {
// Plantillas por rubro: una barbería no puede hablar como un salón de uñas.
// Corre una charla entera con la plantilla de barbería (cliente y dueño) y
// chequea que no se cuele nada del rubro de uñas, que cada negocio pueda pisar
// un texto, y que las plantillas pasen la misma validación que config.json.
const os = require('os');
const path = require('path');

const RUTA_DB = path.join(os.tmpdir(), `test_plantillas_${Date.now()}.db`);
process.env.RUTA_DB = RUTA_DB;

const { armar, ejemplo, validar } = require('../src/config');
const { PLANTILLAS, serviciosDe, plantillaDe } = require('../src/plantillas');

let fallas = 0;
function chequear(nombre, cond) {
  if (cond) console.log(`  ✔ ${nombre}`);
  else { console.log(`  ✘ FALLÓ: ${nombre}`); fallas++; }
}

console.log('\n— 1. Las plantillas pasan la validación de config.json —');
for (const rubro of Object.keys(PLANTILLAS)) {
  const c = armar(ejemplo(), { negocio: { rubro }, servicios: serviciosDe(rubro) });
  const problemas = validar(c);
  chequear(`${rubro}: sin problemas${problemas.length ? ` (${problemas.join('; ')})` : ''}`, problemas.length === 0);
  const claves = Object.keys(PLANTILLAS.unas.textos).sort().join(',');
  chequear(`${rubro}: tiene todos los textos`, Object.keys(plantillaDe(rubro).textos).sort().join(',') === claves);
}

console.log('\n— 2. Rubro desconocido, nombre viejo y textos propios —');
chequear('rubro desconocido no pasa', validar(armar(ejemplo(), { negocio: { rubro: 'gomeria' } }))
  .some((p) => p.startsWith('negocio.rubro')));
const viejo = armar(ejemplo(), { negocio: { rubro: 'salon_de_unas' } });
chequear('"salon_de_unas" (configs ya instaladas) sigue andando', viejo.negocio.rubro === 'unas' && viejo.textos.emoji === '💅');
const propio = armar(ejemplo(), { negocio: { rubro: 'barberia' }, textos: { quien_atiende: 'Nico' } });
chequear('config.json pisa un texto', propio.textos.quien_atiende === 'Nico');
const { aQuienAtiende } = require('../src/plantillas');
chequear('"a la dueña", "al barbero", "a Nico"', aQuienAtiende(PLANTILLAS.unas.textos) === 'a la dueña'
  && aQuienAtiende(PLANTILLAS.barberia.textos) === 'al barbero' && aQuienAtiende(propio.textos) === 'a Nico');
chequear('y conserva los demás de la plantilla', propio.textos.emoji === '💈' && propio.textos.clientes === 'clientes');

console.log('\n— 3. Una charla entera en una barbería —');
const config = armar(ejemplo(), {
  negocio: { rubro: 'barberia', nombre: 'Barbería Sur' },
  servicios: serviciosDe('barberia'),
});
const db = require('../src/db');

// Una base de un celu instalado antes de los alias: la tabla servicios sin esa
// columna. Abrirla tiene que agregarla sin perder lo que había.
const RUTA_VIEJA = path.join(os.tmpdir(), `test_plantillas_vieja_${Date.now()}.db`);
const { abrirBase } = require('../src/db/motor');
const vieja = abrirBase(RUTA_VIEJA);
vieja.exec(`CREATE TABLE servicios (id INTEGER PRIMARY KEY, nombre TEXT NOT NULL, duracion_min INTEGER NOT NULL,
  precio INTEGER NOT NULL, sena INTEGER NOT NULL DEFAULT 0, catalogo_id TEXT NOT NULL DEFAULT '', activo INTEGER NOT NULL DEFAULT 1);
  INSERT INTO servicios (id, nombre, duracion_min, precio) VALUES (9, 'Viejo', 30, 1000);`);
vieja.close();
db.abrir(RUTA_VIEJA);
const migrada = db.obtener().prepare('SELECT * FROM servicios WHERE id = 9').get();
chequear('base vieja: suma la columna alias y conserva el servicio', migrada && migrada.nombre === 'Viejo' && migrada.alias === '');

db.abrir(RUTA_DB);
db.sembrarServicios(config.servicios);
const { crearMotor } = require('../src/core/motor');
const recordatorios = require('../src/core/recordatorios');
const fechas = require('../src/core/fechas');
const motor = crearMotor(config);

const CLIENTE = '5492944333333';
const DUENO = config.numero_duena;
const todo = [];
async function decir(de, texto, extra) {
  const salientes = (await motor.procesarMensaje({ de, texto, ...extra }));
  todo.push(...salientes);
  return salientes;
}
const textoPara = (salientes, quien) => salientes.filter((s) => s.para === quien).map((s) => s.texto).join('\n');

let r = (await decir(CLIENTE, 'hola'));
chequear('menú con 💈', textoPara(r, CLIENTE).includes('Reservar un turno 💈'));
r = (await decir(CLIENTE, '1'));
chequear('lista los servicios de barbería', textoPara(r, CLIENTE).includes('Corte clásico') && textoPara(r, CLIENTE).includes('Platinado'));
await decir(CLIENTE, 'menu');
r = (await decir(CLIENTE, 'quiero un fade'));
chequear('"un fade" encuentra Fade / degradé (alias)', textoPara(r, CLIENTE).includes('*Fade / degradé*'));
await decir(CLIENTE, 'menu');
r = (await decir(CLIENTE, 'quiero turno para corte y barba'));
chequear('"corte y barba" gana sobre el alias "corte"', textoPara(r, CLIENTE).includes('*Corte + barba*'));
await decir(CLIENTE, 'menu');
r = (await decir(CLIENTE, 'quiero un corte'));
chequear('"un corte" es Corte clásico', textoPara(r, CLIENTE).includes('*Corte clásico*'));

// Turno sin seña, de punta a punta (por número, sin depender del texto libre).
await decir(CLIENTE, 'menu');
await decir(CLIENTE, '1');
await decir(CLIENTE, '1');            // corte clásico
await decir(CLIENTE, '1');            // primer día
await decir(CLIENTE, '1');            // primer horario
r = (await decir(CLIENTE, 'Lauti'));
chequear('resumen con 💈', textoPara(r, CLIENTE).includes('💈 Corte clásico'));
r = (await decir(CLIENTE, '1'));
chequear('turno confirmado con 💈', textoPara(r, CLIENTE).includes('💈 Corte clásico'));
chequear('aviso al dueño dice "Cliente:"', textoPara(r, DUENO).includes('Cliente: Lauti'));
chequear('cliente nuevo, en masculino', textoPara(r, DUENO).includes('es cliente nuevo. Tocá el archivo para guardarlo'));

// Recordatorio: se fuerza la ventana para no depender de la hora en que corre el test.
const qTurnos = require('../src/db/consultas/turnos');
const turno = qTurnos.entreFechas('0000', '9999')[0];
const enUnaHora = fechas.aTexto(new Date(Date.now() + 3600000));
db.obtener().prepare('UPDATE turnos SET inicio = ?, fin = ? WHERE id = ?')
  .run(enUnaHora, fechas.sumarMinutos(enUnaHora, 30), turno.id);
const recs = recordatorios.tick(config);
todo.push(...recs);
chequear('recordatorio con 💈', recs.some((s) => s.texto.includes('💈 Corte clásico')));

r = (await decir(CLIENTE, 'necesito hablar con el barbero'));
chequear('"hablar con el barbero" deriva a una persona', textoPara(r, CLIENTE).includes('le aviso al barbero'));

console.log('\n— 4. Lo que escribe el dueño —');
r = (await decir(DUENO, 'ayuda'));
chequear('ayuda con el ejemplo de barbería', textoPara(r, DUENO).includes('el corte ahora sale 13000'));
chequear('ayuda habla de "los clientes"', textoPara(r, DUENO).includes('a TODOS los clientes'));
r = (await decir(DUENO, 'precios'));
chequear('precios con el ejemplo de barbería', textoPara(r, DUENO).includes('el corte ahora sale 13000'));
r = (await decir(DUENO, 'avisale a todos que mañana abrimos tarde'));
chequear('"avisale a todos" arma el aviso masivo', textoPara(r, DUENO).includes('mañana abrimos tarde'));
chequear('y habla de clientes', /\*1 cliente\*/.test(textoPara(r, DUENO)));
await decir(DUENO, 'no');
r = (await decir(DUENO, 'pasame los contactos'));
chequear('contactos: "1 contacto de clientes"', textoPara(r, DUENO).includes('Te paso *1 contacto* de clientes'));

console.log('\n— 5. Nada del salón de uñas se cuela en la barbería —');
const colados = todo.filter((s) => /💅|[Cc]lienta|kapping|la dueña/.test(s.texto || ''));
chequear(`ningún mensaje con 💅, "clienta", "kapping" ni "la dueña"${colados.length ? `: ${colados[0].texto.split('\n')[0]}` : ''}`, colados.length === 0);

console.log(fallas ? `\n❌ ${fallas} chequeos de plantillas fallaron` : '\n✅ Plantillas OK');
process.exit(fallas ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
