// Adentro de Nodo Sur Servicios (BOT_EN_APP), un negocio que todavía no cargó servicios no ofrece los de ejemplo (uñas de demo):
// el pedido de turno o de precios pasa a una persona (El dueño, 2026-10-10).
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot_sin_servicios_'));
process.env.DIR_DATOS = DIR;
process.env.RUTA_DB = path.join(DIR, 'turnos.db');
process.env.BOT_EN_APP = '1';

const configuracion = require('../src/config');
const db = require('../src/db');
const { crearMotor } = require('../src/core/motor');

let fallas = 0;
const chequear = (n, c) => { if (c) console.log(`  ✔ ${n}`); else { console.log(`  ✘ FALLÓ: ${n}`); fallas++; } };

const { config } = configuracion.construir();
chequear('sin servicios la configuración vale igual', configuracion.validar(config).length === 0);
chequear('no trae los servicios ni el alias de demo', config.servicios.length === 0 && !config.senas.alias_mp && !config.senas.habilitadas);
db.abrir(process.env.RUTA_DB);
db.sembrarServicios(config.servicios);
const motor = crearMotor(config);
const turno = motor.procesarMensaje({ de: '5492944111999', texto: 'hola, quiero un turno' });
chequear('pedir turno pasa a una persona, sin listar nada', turno[0].texto.includes('cargando los servicios') && !/Semipermanente|Kapping/.test(JSON.stringify(turno)));
const precios = motor.procesarMensaje({ de: '5492944111888', texto: '2' });
chequear('pedir precios tampoco muestra los de ejemplo', !/Semipermanente|Kapping/.test(JSON.stringify(precios)));

console.log(fallas ? `\n❌ ${fallas} chequeos sin servicios fallaron` : '\n✅ Sin servicios OK');
process.exit(fallas ? 1 : 0);
