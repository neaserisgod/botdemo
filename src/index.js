// Arranque de bot-turnos: junta config + DB + núcleo + adaptador + cron + panel.
// Elegís el adaptador con la variable ADAPTADOR: whatsappweb (demo PC),
// consola (pruebas sin WhatsApp), baileys (fase 2, celu).
const cron = require('node-cron');
const config = require('./config').cargar(); // valida y avisa si algo está mal
const db = require('./db');
const qTurnos = require('./db/consultas/turnos');

// --- Red de contención ---
// Sin esto, cualquier error no capturado (una promesa que falla en Baileys, un
// archivo que no se puede escribir) mata el proceso y el bot deja de atender
// hasta que PM2 lo levante. Preferimos loguear y seguir vivos.
process.on('uncaughtException', (e) => {
  console.error('[ERROR NO CAPTURADO]', e && e.stack ? e.stack : e);
});
process.on('unhandledRejection', (e) => {
  console.error('[PROMESA RECHAZADA]', e && e.stack ? e.stack : e);
});
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

    // Modo vinculación: ya quedó la sesión guardada, salimos para que PM2 lo
    // levante como servicio (no tiene sentido dejar esta instancia corriendo).
    if (process.argv.includes('--pareo')) {
      console.log('\n✅ Vinculado. La sesión quedó guardada en data/sesion-baileys/');
      setTimeout(() => process.exit(0), 2000); // que termine de escribir las credenciales
      return;
    }
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

// --- Envío desde tareas programadas ---
// Nada de lo que pase acá adentro puede tumbar el proceso: si una tarea falla,
// se loguea y el bot sigue atendiendo.
async function enviarSiConectado(salientes) {
  try {
    if (!estado.conectado || !salientes || !salientes.length) return;
    const enviados = await adaptador.enviar(salientes);

    // Un recordatorio se marca como enviado SOLO si salió de verdad. Si el
    // envío falló, queda sin marcar y el próximo tick lo reintenta.
    for (const s of enviados || []) {
      if (s.turnoId) qTurnos.marcarRecordatorioEnviado(s.turnoId);
    }
  } catch (e) {
    console.error('Error enviando desde una tarea programada:', e.message);
  }
}

// Envuelve cada tarea de cron para que un error no mate el proceso.
function tarea(nombre, fn) {
  return async () => {
    try {
      await enviarSiConectado(await fn());
    } catch (e) {
      console.error(`Error en la tarea "${nombre}":`, e.message);
    }
  };
}

// Recordatorios + señas vencidas, cada 5 min
cron.schedule(config.recordatorios.chequeo_cron,
  tarea('recordatorios', () => recordatorios.tick(config)));

// Batería (corte de luz), cada 5 min — no hace nada fuera de Termux
cron.schedule('*/5 * * * *',
  tarea('batería', () => salud.chequearBateria(config)));

// Agenda diaria a la dueña
const [hAg, mAg] = config.notificaciones_duena.agenda_diaria_hora.split(':');
cron.schedule(`${mAg} ${hAg} * * *`,
  tarea('agenda diaria', () => recordatorios.agendaDiaria(config)));

// Resumen semanal
const DIA_CRON = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
const [hRes, mRes] = config.notificaciones_duena.resumen_semanal_hora.split(':');
cron.schedule(`${mRes} ${hRes} * * ${DIA_CRON[config.notificaciones_duena.resumen_semanal_dia]}`,
  tarea('resumen semanal', () => recordatorios.resumenSemanal(config)));

// Latido diario a mi número (solo salud del sistema)
const [hLat, mLat] = config.latido.hora.split(':');
cron.schedule(`${mLat} ${hLat} * * *`,
  tarea('latido', () => salud.latido(config)));

// Limpieza de archivos viejos (comprobantes, .ics, .vcf): en un celu el espacio
// es finito y estos se acumulan para siempre. Todos los días a las 4 AM.
cron.schedule('0 4 * * *', () => {
  try {
    limpiarArchivosViejos();
  } catch (e) {
    console.error('Error limpiando archivos viejos:', e.message);
  }
});

function limpiarArchivosViejos() {
  const fs = require('fs');
  const path = require('path');
  const diasQueGuardamos = config.limpieza?.dias ?? 90;
  const limite = Date.now() - diasQueGuardamos * 86400000;
  let borrados = 0;
  for (const carpeta of ['comprobantes', 'calendario', 'contactos']) {
    const dir = path.join(__dirname, '..', 'data', carpeta);
    if (!fs.existsSync(dir)) continue;
    for (const archivo of fs.readdirSync(dir)) {
      const ruta = path.join(dir, archivo);
      try {
        if (fs.statSync(ruta).mtimeMs < limite) { fs.unlinkSync(ruta); borrados++; }
      } catch { /* si no se puede borrar, seguimos */ }
    }
  }
  if (borrados) console.log(`Limpieza: ${borrados} archivos de más de ${diasQueGuardamos} días`);
}

// --- Panel + arranque ---
iniciarPanel(config, () => estado);
adaptador.iniciar();
