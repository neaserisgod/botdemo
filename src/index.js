// Arranque de bot-turnos: junta config + DB + núcleo + adaptador + cron + panel.
// Elegís el adaptador con la variable ADAPTADOR: whatsappweb (demo PC),
// consola (pruebas sin WhatsApp), baileys (fase 2, celu).
const cron = require('node-cron');
const configuracion = require('./config');
const config = configuracion.cargar(); // valida y avisa si algo está mal
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

// --- Una sola instancia a la vez ---
// Dos procesos con la misma sesión de WhatsApp se desconectan mutuamente en
// loop: el bot parece "online" en PM2 pero no contesta. Es la causa típica de
// que un `pm2 restart` no alcance y haya que borrar y recrear el proceso.
const fsLock = require('fs');
const pathLock = require('path');
const RUTA_PID = pathLock.join(__dirname, '..', 'data', 'bot.pid');

function tomarLock() {
  fsLock.mkdirSync(pathLock.dirname(RUTA_PID), { recursive: true });
  if (fsLock.existsSync(RUTA_PID)) {
    const otro = parseInt(fsLock.readFileSync(RUTA_PID, 'utf8').trim(), 10);
    if (otro && otro !== process.pid) {
      let vivo = false;
      try { process.kill(otro, 0); vivo = true; } catch { vivo = false; }
      if (vivo) {
        console.error('');
        console.error('❌ Ya hay otro bot corriendo (PID ' + otro + ').');
        console.error('   Dos instancias con la misma sesión de WhatsApp se rompen entre sí.');
        console.error('   Arreglalo con:   bash bot.sh reiniciar');
        console.error('');
        process.exit(1);
      }
      console.log(`(Había un PID viejo de un proceso muerto, lo piso)`);
    }
  }
  fsLock.writeFileSync(RUTA_PID, String(process.pid));
  const soltar = () => { try { fsLock.unlinkSync(RUTA_PID); } catch { /* ya no está */ } };
  process.on('exit', soltar);
  process.on('SIGINT', () => { soltar(); process.exit(0); });
  process.on('SIGTERM', () => { soltar(); process.exit(0); });
}
tomarLock();

// --- DB + servicios sembrados desde config ---
db.abrir(process.env.RUTA_DB);
db.sembrarServicios(config.servicios);
salud.registrarArranque();

const motor = crearMotor(config);
const estado = { conectado: false };

// Nodo Sur (opcional): el catálogo que quedó guardado, para atender aunque el celu arranque sin internet.
const nube = require('./nube/sincronizar');
if (config.forma === 'productos' && !nube.cargarCatalogoGuardado()) {
  console.log('Todavía no hay catálogo de Nodo Sur guardado: se baja apenas haya conexión.');
}

// --- Adaptador ---
// Se elige con --adaptador=X (anda en Windows) o la variable ADAPTADOR (Linux/Termux)
const arg = process.argv.find((a) => a.startsWith('--adaptador='));
const nombreAdaptador = (arg && arg.split('=')[1]) || process.env.ADAPTADOR || 'whatsappweb';
const { crearAdaptador } = require(`./adaptadores/${nombreAdaptador}`);

// Sin Nodo Sur no hay a dónde mandar los pedidos (queda en no hacer nada).
let mandarPedidosYa = () => {};
const adaptador = crearAdaptador(config, {
  alRecibir: (msj) => {
    const salientes = motor.procesarMensaje(msj);
    // Un pedido recién confirmado sale a Nodo Sur ya, no en la vuelta de cada 10 minutos: el local lo tiene que ver mientras
    // el cliente espera la respuesta. Si falla, queda en la bandeja para la vuelta siguiente.
    mandarPedidosYa();
    return salientes;
  },

  // El dueño contestó a mano desde el WhatsApp del negocio: el bot se calla en ese chat un rato.
  alResponderDueno: (numero) => motor.pausar(numero),

  alConectar: () => {
    const primeraVez = !estado.conectado;
    estado.conectado = true;
    console.log('WhatsApp conectado.');

    // Modo vinculación: ya quedó la sesión guardada, salimos para que PM2 lo
    // levante como servicio (no tiene sentido dejar esta instancia corriendo).
    if (process.argv.includes('--pareo')) {
      // No salir enseguida: recién vinculado, WhatsApp le sigue pasando al bot las claves de cifrado de los chats
      // (pre-keys, estado de la cuenta). Cortar a los 2 s dejaba la sesión a medias y después ningún mensaje se podía
      // descifrar ("Bad MAC"). Un minuto alcanza de sobra.
      console.log('\n✅ Vinculado. Termino de sincronizar las claves con WhatsApp (1 minuto, no cierres Termux)...');
      setTimeout(() => process.exit(0), 60000);
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

// Las tareas que dependen de la configuración (horarios de la agenda, del resumen, del latido) se arman acá, para
// volver a armarlas cuando la configuración cambia desde Nodo Sur sin reiniciar el bot.
let tareasProgramadas = [];
function programarTareas() {
  for (const t of tareasProgramadas) t.stop();
  tareasProgramadas = [];
  const programar = (expr, fn) => tareasProgramadas.push(cron.schedule(expr, fn));

  // Recordatorios + señas vencidas, cada 5 min
  programar(config.recordatorios.chequeo_cron,
    tarea('recordatorios', () => recordatorios.tick(config)));

  // Batería (corte de luz), cada 5 min — no hace nada fuera de Termux
  programar('*/5 * * * *',
    tarea('batería', () => salud.chequearBateria(config)));

  // Agenda diaria a la dueña
  const [hAg, mAg] = config.notificaciones_duena.agenda_diaria_hora.split(':');
  programar(`${mAg} ${hAg} * * *`,
    tarea('agenda diaria', () => recordatorios.agendaDiaria(config)));

  // Resumen semanal
  const DIA_CRON = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
  const [hRes, mRes] = config.notificaciones_duena.resumen_semanal_hora.split(':');
  programar(`${mRes} ${hRes} * * ${DIA_CRON[config.notificaciones_duena.resumen_semanal_dia]}`,
    tarea('resumen semanal', () => recordatorios.resumenSemanal(config)));

  // Latido diario a mi número (solo salud del sistema)
  const [hLat, mLat] = config.latido.hora.split(':');
  programar(`${mLat} ${hLat} * * *`,
    tarea('latido', () => salud.latido(config)));
}
programarTareas();

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

// --- Nodo Sur ---
// Mensajes que salen ahora mismo (avisos de pedidos resueltos): devuelve los que salieron de verdad.
async function enviarAhora(salientes) {
  if (!estado.conectado) return [];
  try { return (await adaptador.enviar(salientes)) || []; } catch { return []; }
}

// La configuración cambió en Nodo Sur: se vuelve a leer en el lugar (el motor y las tareas tienen la misma referencia),
// se siembran los servicios y se reprograman las tareas. Si no pasa la validación, sigue la anterior.
function recargarConfig() {
  const problemas = configuracion.recargar(config);
  if (problemas.length) return problemas;
  db.sembrarServicios(config.servicios || []);
  programarTareas();
  return [];
}

const cuentaNube = require('./nube/cuenta').leer();
if (cuentaNube) {
  const { crearCliente } = require('./nube/cliente');
  const sincronizador = nube.crearSincronizador({
    config, recargarConfig, enviar: enviarAhora,
    cliente: crearCliente({ sitio: cuentaNube.sitio, token: cuentaNube.token }),
    version: require('../package.json').version,
  });
  let WebSocket = null;
  try { WebSocket = require('ws'); } catch { console.log('Sin el paquete ws: Nodo Sur se revisa cada 10 minutos, sin avisos en vivo.'); }
  sincronizador.iniciar({ WebSocket });
  // Un pedido o un turno sale apenas termina la charla que lo creó, no en la vuelta de cada 10 minutos.
  mandarPedidosYa = () => { sincronizador.mandarYa().catch(() => { /* queda para la próxima vuelta */ }); };
  console.log(`Vinculado a Nodo Sur (${cuentaNube.email}).`);
} else {
  console.log('Sin vincular a Nodo Sur: el bot usa solo config.json (para vincularlo: bash bot.sh vincular-nodosur).');
}

// --- Panel + arranque ---
iniciarPanel(config, () => estado);
adaptador.iniciar();
