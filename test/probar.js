// El simulador (scripts/probar.js): chatear con el bot como cliente o como dueña, sin WhatsApp, con una base de prueba.
process.env.TZ = 'America/Argentina/Buenos_Aires';
const os = require('os');
const path = require('path');
process.env.RUTA_DB = path.join(os.tmpdir(), `test_probar_${Date.now()}.db`);
const { armar, ejemplo } = require('../src/config');
const db = require('../src/db');
const { crearSimulador } = require('../scripts/probar');

let fallas = 0;
const chequear = (nombre, cond) => { if (cond) console.log(`  ✔ ${nombre}`); else { console.log(`  ✘ FALLÓ: ${nombre}`); fallas++; } };

(async () => {
  const config = armar(ejemplo());
  db.abrir(process.env.RUTA_DB);
  db.sembrarServicios(config.servicios);
  const servidor = crearSimulador(config).listen(0, '127.0.0.1');
  await new Promise((r) => servidor.once('listening', r));
  const url = `http://127.0.0.1:${servidor.address().port}`;
  const decir = async (como, texto) => (await (await fetch(`${url}/mensaje`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ como, texto }) })).json()).respuestas;

  console.log('\n— Simulador —');
  const pagina = await (await fetch(url)).text();
  chequear('la página carga, con los dos botones', pagina.includes('Soy cliente') && pagina.includes('Soy la dueña'));
  let r = await decir('cliente', 'hola');
  chequear('como cliente: el bot le contesta al cliente', r.length === 1 && r[0].a === 'cliente' && r[0].texto.includes('¿Qué necesitás?'));
  r = await decir('cliente', 'necesito hablar con alguien');
  chequear('lo que el bot le manda a la dueña se ve aparte', r.some((x) => x.a === 'duena') && r.some((x) => x.a === 'cliente'));
  r = await decir('cliente', 'hola');
  chequear('y la pausa se respeta (como en WhatsApp)', r.length === 0);
  await fetch(`${url}/nuevo`, { method: 'POST' });
  r = await decir('cliente', 'hola');
  chequear('"charla nueva": otro cliente, sin pausa', r.length === 1 && r[0].a === 'cliente');
  await decir('cliente', 'tienen estacionamiento?');
  r = await decir('duena', 'qué no entendiste');
  chequear('como dueña: sus comandos', r.length === 1 && r[0].a === 'duena' && r[0].texto.includes('estacionamiento'));
  const ne = await (await fetch(`${url}/no-entendidos`)).json();
  chequear('el botón "no entendió" lista lo de la prueba', ne.some((x) => x.texto.includes('estacionamiento')));
  const malo = await fetch(`${url}/mensaje`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  chequear('un mensaje vacío no rompe nada', malo.status === 400);

  servidor.close();
  console.log(fallas ? `\n❌ ${fallas} chequeos del simulador fallaron` : '\n✅ Simulador OK');
  process.exit(fallas ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
