// Arranque de bot-turnos: junta config + DB + núcleo + adaptador + cron + panel.
// Elegís el adaptador con la variable ADAPTADOR: whatsappweb (demo PC),
// consola (pruebas sin WhatsApp), baileys (fase 2, celu).
const path = require('path');
const cron = require('node-cron');
const config = require(path.join(__dirname, '..', 'config.json'));
const db = require('./db');
const { crearMotor } = require('./core/motor');
const recordatorios = require('./core/recordatorios');
const salud = require('./salud');
const { iniciarPanel } = require('./panel/server');

// --- DB + servicios sembrados desde config ---
db.abrir(process.env.RUTA_DB);
db.sembrarServicios(config.servicios);
salud.registrarArranque();

const motor = crearMotor(config);
const estado = { conectado: false };

// --- Adaptador ---
// Se elige con --adaptador=X (anda en Windows) o la variable ADAPTADOR (Linux/Termux)
const arg = process.argv.find((a) => a.startsWith('--adaptador='));
const nombreAdaptador = (arg && arg.split('=')[1]) || process.env.ADAPTADOR || 'whatsappweb';
const { crearAdaptador } = require(`./adaptadores/${nombreAdaptador}`);

const adaptador = crearAdaptador(config, {
  alRecibir: (msj) => motor.procesarMensaje(msj),

  alConectar: () => {
    const primeraVez = !estado.conectado;
    estado.conectado = true;
    console.log('WhatsApp conectado.');
    // Aviso a la dueña si venimos de una caída
    adaptador.enviar(salud.alReconectar(config));
    // Catch-up: recordatorios que quedaron pendientes mientras estaba caído
    if (primeraVez) adaptador.enviar(recordatorios.tick(config));
  },

  alDesconectar: (motivo) => {
    estado.conectado = false;
    salud.registrarCaida(motivo);
    console.error('WhatsApp desconectado:', motivo);
  },
});

// --- Cron (solo despacha si hay conexión; si no, el catch-up lo levanta después) ---
const enviarSiConectado = (salientes) => {
  if (estado.conectado && salientes.length) adaptador.enviar(salientes);
};

// Recordatorios + señas vencidas, cada 5 min
cron.schedule(config.recordatorios.chequeo_cron, () => {
  enviarSiConectado(recordatorios.tick(config));
});

// Batería (corte de luz), cada 5 min — no hace nada fuera de Termux
cron.schedule('*/5 * * * *', () => {
  enviarSiConectado(salud.chequearBateria(config));
});

// Agenda diaria a la dueña
const [hAg, mAg] = config.notificaciones_duena.agenda_diaria_hora.split(':');
cron.schedule(`${mAg} ${hAg} * * *`, () => {
  enviarSiConectado(recordatorios.agendaDiaria(config));
});

// Resumen semanal
const DIA_CRON = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
const [hRes, mRes] = config.notificaciones_duena.resumen_semanal_hora.split(':');
cron.schedule(`${mRes} ${hRes} * * ${DIA_CRON[config.notificaciones_duena.resumen_semanal_dia]}`, () => {
  enviarSiConectado(recordatorios.resumenSemanal(config));
});

// Latido diario a mi número (solo salud del sistema)
const [hLat, mLat] = config.latido.hora.split(':');
cron.schedule(`${mLat} ${hLat} * * *`, () => {
  enviarSiConectado(salud.latido(config));
});

// --- Panel + arranque ---
iniciarPanel(config, () => estado);
adaptador.iniciar();
