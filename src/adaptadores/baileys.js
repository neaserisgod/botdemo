// Adaptador Baileys — producción (celu con Termux) y también anda en PC.
// Sin Chromium: se conecta directo al protocolo de WhatsApp Web.
// Sesión propia en data/sesion-baileys/ (NO toca la sesión de otro bot:
// vincular acá agrega un dispositivo nuevo a la cuenta, no desloguea nada).
const fs = require('fs');
const path = require('path');
const { separarOpciones } = require('../core/opciones');
const { crearRegistroEncuestas, descifrarVoto } = require('./encuestas');

function crearAdaptador(config, hooks) {
  // Baileys 7 (2026-10-09): con la 6 (ya "legacy") ningún mensaje entrante se podía descifrar ("Bad MAC") desde que
  // WhatsApp pasó a los chats @lid. La 7 es un módulo ES: se carga con import() al conectar, que anda en cualquier
  // Node 20+ (require() de un módulo ES recién viene sin bandera desde Node 22.12).
  let baileys = null;
  const cargarBaileys = async () => {
    if (!baileys) {
      const m = await import('@whiskeysockets/baileys');
      baileys = { ...m, makeWASocket: m.makeWASocket || m.default };
    }
    return baileys;
  };
  const qrcode = require('qrcode-terminal');
  const pino = require('pino'); // viene como dependencia de baileys

  const dirSesion = require('../rutas').enDatos('sesion-baileys');
  const dirMedia = require('../rutas').enDatos('comprobantes');
  fs.mkdirSync(dirMedia, { recursive: true });

  const logger = pino({ level: 'silent' }); // el ruido de baileys no nos sirve
  // Menús como encuesta (`core/opciones.js`); `"encuestas": false` en config.json vuelve a los números escritos.
  const conEncuestas = config.encuestas !== false;
  const encuestas = crearRegistroEncuestas({ ruta: require('../rutas').enDatos('encuestas.json') });
  let sock = null;
  let cerrando = false;
  let reconectando = false;

  // --- Watchdog de conexión zombi ---
  // El problema real en un celu: la conexión TCP muere sin avisar (cambio de
  // WiFi a datos, el router cierra la sesión inactiva, Android suspende la
  // red). Baileys no dispara 'close', el socket queda abierto pero muerto y el
  // bot deja de responder aunque PM2 lo vea "online". La única forma de
  // detectarlo es medir el silencio: si no llega NADA (ni mensajes, ni
  // presencias, ni keep-alives) durante mucho rato, damos la conexión por
  // muerta y forzamos una reconexión.
  let ultimaActividad = Date.now();
  let intentosFallidos = 0;
  const MINUTOS_SIN_SENAL = config.conexion?.minutos_sin_senal ?? 10;
  const INTENTOS_ANTES_DE_REINICIAR = config.conexion?.intentos_antes_de_reiniciar ?? 3;

  const marcarActividad = () => { ultimaActividad = Date.now(); intentosFallidos = 0; };

  setInterval(() => {
    if (cerrando || reconectando) return;
    const minutos = (Date.now() - ultimaActividad) / 60000;
    if (minutos < MINUTOS_SIN_SENAL) return;

    intentosFallidos++;
    console.error(`⚠️  ${Math.round(minutos)} min sin señal de WhatsApp (intento ${intentosFallidos}/${INTENTOS_ANTES_DE_REINICIAR}). Reconectando...`);
    hooks.alDesconectar(`sin señal ${Math.round(minutos)} min (conexión zombi)`);

    if (intentosFallidos >= INTENTOS_ANTES_DE_REINICIAR) {
      // Reconectar dentro del mismo proceso no alcanzó: salimos para que PM2
      // levante todo limpio. Es lo mismo que hacer "bot.sh reiniciar" pero solo.
      console.error('❌ No se pudo recuperar la conexión. Reinicio el proceso (PM2 lo levanta).');
      process.exit(1);
    }

    ultimaActividad = Date.now(); // no reintentar en el próximo tick
    try { sock?.end?.(new Error('watchdog: conexión zombi')); } catch { /* ya estaba muerto */ }
    reconectando = true;
    setTimeout(() => {
      reconectando = false;
      conectar().catch((e) => console.error('Reconexión falló:', e.message));
    }, 3000);
  }, 60000).unref?.();

  // Chats nuevos con @lid: guardamos a qué JID responderle a cada número.
  const jidPorNumero = new Map();
  const jidDe = (numero) => jidPorNumero.get(numero) || `${numero}@s.whatsapp.net`;

  // Mapeo LID → número real, persistido en disco: WhatsApp a veces manda el
  // mensaje identificado con un ID interno (@lid) SIN el número real adjunto.
  // Si no lo resolvemos, la dueña cae al flujo de clienta. Con que una vez
  // llegue el número real, lo recordamos para siempre.
  const rutaLidMap = require('../rutas').enDatos('lid-map.json');
  let lidMap = {};
  try { lidMap = JSON.parse(fs.readFileSync(rutaLidMap, 'utf8')); } catch { /* primera vez */ }
  function recordarLid(lid, numero) {
    if (lidMap[lid] === numero) return;
    lidMap[lid] = numero;
    try { fs.writeFileSync(rutaLidMap, JSON.stringify(lidMap)); } catch (e) {
      console.error('No pude guardar lid-map.json:', e.message);
    }
  }

  async function conectar() {
    const { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = await cargarBaileys();
    const { state, saveCreds } = await useMultiFileAuthState(dirSesion);
    // Versión de protocolo actual: evita el clásico "connection closed" por versión vieja
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* usa la default */ }

    sock = makeWASocket({
      // Las claves de cifrado por chat, con caché en memoria (lo que recomienda Baileys): sin esto, dos mensajes que
      // llegan juntos leen y escriben el mismo archivo de sesión a la vez y la sesión queda rota ("Bad MAC").
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      version,
      // Cuando el otro celular no pudo descifrar algo que mandó el bot, pide que se lo reenvíe: hay que tenerlo a mano.
      getMessage: async (key) => enviadosRecientes.get(key.id),
      logger,
      markOnlineOnConnect: false, // no pisar las notificaciones del celu de la dueña
      syncFullHistory: false,     // celus de 2-3 GB: nada de bajar historial
      // Latido cada 25 s: mantiene viva la conexión a través del NAT del router
      // y de la red móvil, y le da señal al watchdog de que seguimos vivos.
      keepAliveIntervalMs: 25000,
      connectTimeoutMs: 60000,
      retryRequestDelayMs: 3000,
    });

    marcarActividad();
    sock.ev.on('creds.update', () => { marcarActividad(); return saveCreds(); });
    // Cualquier señal de vida cuenta: presencias, recibos, historial, lo que sea.
    for (const evento of ['messages.upsert', 'messages.update', 'presence.update',
      'chats.update', 'contacts.update', 'message-receipt.update', 'connection.update']) {
      sock.ev.on(evento, marcarActividad);
    }

    // Emparejamiento por CÓDIGO (para el celu: no podés escanear el QR de tu
    // propia pantalla). Corré con --pareo y meté el código en el WhatsApp del
    // bot: Dispositivos vinculados > Vincular con el número de teléfono.
    if (!state.creds.registered && (process.argv.includes('--pareo') || process.env.PAREO)) {
      setTimeout(async () => {
        try {
          // NUMERO_BOT: la app que trae el bot adentro lo pasa, porque al arrancar la primera vez todavía no bajó la configuración.
          const numero = String(process.env.NUMERO_BOT || config.numero_actual).replace(/\D/g, '');
          const codigo = await sock.requestPairingCode(numero);
          hooks.alCodigo?.(codigo, numero);
          console.log('==========================================');
          console.log(`  CÓDIGO DE VINCULACIÓN: ${codigo}`);
          console.log(`  (para el número ${numero})`);
          console.log('  WhatsApp > Dispositivos vinculados >');
          console.log('  Vincular con el número de teléfono');
          console.log('==========================================');
        } catch (e) {
          console.error('No pude pedir el código de vinculación:', e.message);
        }
      }, 3000);
    }

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      // En modo pareo no mostramos el QR: confunde y encima tapa el código.
      if (qr && !process.argv.includes('--pareo')) {
        console.log('Escaneá este QR desde WhatsApp > Dispositivos vinculados:');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'open') { marcarActividad(); intentosFallidos = 0; hooks.alConectar(); }
      if (connection === 'close') {
        const codigo = lastDisconnect?.error?.output?.statusCode;
        const deslogueado = codigo === baileys.DisconnectReason.loggedOut;
        hooks.alDesconectar(`baileys close (código ${codigo ?? '?'})`);
        if (deslogueado) {
          console.error('Sesión cerrada desde el teléfono. Borrá data/sesion-baileys y re-escaneá el QR.');
          hooks.alDesloguear?.();
          return;
        }
        // Un solo reintento a la vez: sin esta guarda, varios eventos "close"
        // seguidos programan varios timers y terminás con conexiones paralelas
        // peleando por la misma sesión.
        if (!cerrando && !reconectando) {
          reconectando = true;
          console.log('Reconectando en 5 s...');
          setTimeout(() => {
            reconectando = false;
            conectar().catch((e) => console.error('Reconexión falló:', e.message));
          }, 5000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const msg of messages) {
        try {
          // Lo que mandó el propio número desde otro dispositivo: puede llegar como 'notify' o como 'append' según
          // cómo lo sincronice WhatsApp.
          if (msg.key?.fromMe) { await procesarPropio(msg); continue; }
          if (type !== 'notify') continue; // solo mensajes nuevos, no historial
          await procesarEntrante(msg);
        } catch (e) {
          console.error('Error procesando mensaje:', e.message);
        }
      }
    });
  }

  // Ids de lo que mandó el bot, para distinguirlo de lo que el dueño escribe a mano con el mismo número. Acotado:
  // alcanza con los últimos, porque lo propio vuelve enseguida.
  const enviadosPorBot = new Set();
  // Lo último que mandó el bot, por id, para reenviarlo si el destinatario lo pide (getMessage).
  const enviadosRecientes = new Map();
  function recordarEnviado(r) {
    const id = r?.key?.id;
    if (!id) return;
    enviadosPorBot.add(id);
    if (enviadosPorBot.size > 500) enviadosPorBot.delete(enviadosPorBot.values().next().value);
    if (r.message) {
      enviadosRecientes.set(id, r.message);
      if (enviadosRecientes.size > 200) enviadosRecientes.delete(enviadosRecientes.keys().next().value);
    }
  }

  // Un mensaje del propio número que no mandó el bot: el dueño contestó a mano desde su celular. El bot se calla en
  // ese chat (config.pausa_minutos).
  async function procesarPropio(msg) {
    if (!msg.message || enviadosPorBot.has(msg.key.id)) return;
    const remoteJid = msg.key.remoteJid || '';
    if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') return;
    // Solo lo reciente: al reconectar, WhatsApp puede reenviar mensajes viejos del historial.
    const segundos = Number(msg.messageTimestamp || 0);
    if (segundos && Date.now() / 1000 - segundos > 120) return;
    if (hooks.alResponderDueno) hooks.alResponderDueno(await numeroDe(msg, remoteJid));
  }

  async function numeroDe(msg, remoteJid) {
    // Chats @lid: buscar el número real en (1) senderPn del mensaje,
    // (2) el mapeo guardado, (3) el resolvedor interno de baileys.
    let jidNumero = remoteJid;
    if (remoteJid.endsWith('@lid')) {
      const lid = remoteJid.split('@')[0].split(':')[0];
      // Baileys 7 trae el número en remoteJidAlt/participantAlt; los otros dos son de la 6.
      const pnDelMsj = msg.key.remoteJidAlt || msg.key.participantAlt || msg.key.senderPn || msg.key.participantPn;
      if (pnDelMsj) {
        jidNumero = pnDelMsj;
        recordarLid(lid, pnDelMsj.split('@')[0].split(':')[0]);
      } else if (lidMap[lid]) {
        jidNumero = `${lidMap[lid]}@s.whatsapp.net`;
      } else if (sock.signalRepository?.lidMapping?.getPNForLID) {
        try {
          const pn = await sock.signalRepository.lidMapping.getPNForLID(remoteJid);
          if (pn) { jidNumero = pn; recordarLid(lid, pn.split('@')[0].split(':')[0]); }
        } catch { /* seguimos con el lid pelado */ }
      }
    }
    const de = jidNumero.split('@')[0].split(':')[0];
    jidPorNumero.set(de, remoteJid);
    return de;
  }

  async function procesarEntrante(msg) {
    if (!msg.message || msg.key.fromMe) return;
    const remoteJid = msg.key.remoteJid || '';
    if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') return;
    const de = await numeroDe(msg, remoteJid);

    // Tildes azules: la clienta ve que el mensaje se leyó (El dueño, 2026-10-11).
    sock.readMessages([msg.key]).catch(() => {});

    const m = msg.message;
    if (m.pollUpdateMessage) { await procesarVoto(msg, de); return; }
    const texto = m.conversation
      || m.extendedTextMessage?.text
      || m.imageMessage?.caption
      || '';
    if (process.env.DEPURAR) console.log(`[msj] de=${de} jid=${remoteJid} texto="${texto.slice(0, 40)}"`);

    // Foto (comprobante): bajar a disco para el OCR con tesseract
    let rutaImagen = null;
    if (m.imageMessage) {
      const buffer = await baileys.downloadMediaMessage(msg, 'buffer', {}, {
        logger, reuploadRequest: sock.updateMediaMessage,
      });
      rutaImagen = path.join(dirMedia, `${de}_${Date.now()}.jpg`);
      fs.writeFileSync(rutaImagen, buffer);
    }

    // Ítem del catálogo tocado por la clienta
    const productoId = m.productMessage?.product?.productId || null;

    // Audio o nota de voz: el bot no los escucha, pero le avisa al cliente (ver motor.js).
    const tipo = m.audioMessage ? 'audio' : null;
    const salientes = hooks.alRecibir({ de, texto, rutaImagen, productoId, tipo });
    await enviarTodos(salientes, { respondiendo: de });
  }

  // Un voto en una encuesta del bot: vuelve al núcleo como el número de la opción (`adaptadores/encuestas.js`).
  async function procesarVoto(msg, de) {
    const pu = msg.message.pollUpdateMessage;
    const id = pu.pollCreationMessageKey?.id;
    const encuesta = encuestas.vigente(id, de);
    if (!encuesta) {
      // Una encuesta vieja: lo que se elija ahí ya no corresponde a esta parte de la charla.
      await enviarTodos([{ para: de, texto: 'Esa encuesta ya pasó 😊 Contestame la última, o escribime lo que necesitás.' }], { respondiendo: de });
      return;
    }
    const yo = sock.user || {};
    const normal = (j) => (j ? baileys.jidNormalizedUser(j) : null);
    const voto = descifrarVoto(baileys.decryptPollVote, {
      voto: pu.vote,
      secreto: encuesta.mensaje?.messageContextInfo?.messageSecret,
      idEncuesta: id,
      creadores: [normal(yo.id), normal(yo.lid)],
      votantes: [msg.key.participant, msg.key.participantAlt, msg.key.remoteJid, msg.key.remoteJidAlt, jidDe(de), `${de}@s.whatsapp.net`].map(normal),
    });
    if (!voto) {
      console.error(`No pude descifrar un voto de ${de} (encuesta ${id})`);
      await enviarTodos([{ para: de, texto: 'Perdón, no pude leer lo que marcaste 😅 ¿Me lo escribís?' }], { respondiendo: de });
      return;
    }
    const numero = encuestas.votar(id, voto.selectedOptions);
    if (numero === null) return; // sacó el voto
    if (process.env.DEPURAR) console.log(`[voto] de=${de} encuesta=${id} opción=${numero}`);
    const salientes = hooks.alRecibir({ de, texto: String(numero) });
    await enviarTodos(salientes, { respondiendo: de });
  }

  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  // Devuelve los mensajes que SÍ salieron, para que el llamador sepa qué se
  // envió de verdad (lo usan los recordatorios antes de marcarlos).
  // "Escribiendo…" antes de contestar (El dueño, 2026-10-11): un segundo, más si el mensaje es largo, nunca más de dos. Solo
  // al contestarle a alguien que acaba de escribir: los recordatorios y avisos salen sin esperar.
  async function escribiendo(jid, texto) {
    try {
      await sock.sendPresenceUpdate('composing', jid);
      await dormir(Math.min(2000, 600 + (texto || '').length * 8));
    } catch { /* si no se puede mostrar, se contesta igual */ }
  }

  // El texto de un menú: como encuesta si se puede (`core/opciones.js`), y si la encuesta no sale, como siempre.
  // `conEncuesta`: a quiénes ya se les mandó una encuesta en esta misma tanda (un texto que viene después en la misma respuesta
  // no la anula: es parte de lo mismo).
  async function enviarTexto(jid, s, conEncuesta) {
    const partes = conEncuestas ? separarOpciones(s.texto) : null;
    if (!partes) {
      recordarEnviado(await sock.sendMessage(jid, { text: s.texto }));
      if (!conEncuesta.has(s.para)) encuestas.olvidar(s.para);
      return;
    }
    if (partes.texto) recordarEnviado(await sock.sendMessage(jid, { text: partes.texto }));
    try {
      const r = await sock.sendMessage(jid, {
        poll: { name: partes.pregunta, values: partes.opciones.map((o) => o.texto), selectableCount: 1 },
      });
      recordarEnviado(r);
      encuestas.registrar(r?.key?.id, s.para, partes.opciones, r?.message);
      conEncuesta.add(s.para);
    } catch (e) {
      console.error(`No salió la encuesta a ${s.para} (${e.message}): mando la lista con números`);
      const lista = partes.opciones.map((o) => `*${o.numero}* — ${o.texto}`).join('\n');
      recordarEnviado(await sock.sendMessage(jid, { text: `${partes.pregunta}\n\n${lista}\n\nRespondé con el número.` }));
      encuestas.olvidar(s.para);
    }
  }

  // Devuelve los mensajes que SÍ salieron, para que el llamador sepa qué se
  // envió de verdad (lo usan los recordatorios antes de marcarlos).
  async function enviarTodos(salientes, { respondiendo } = {}) {
    const enviados = [];
    const conEncuesta = new Set();
    for (const s of salientes || []) {
      try {
        // demora: los envíos masivos van espaciados para no disparar el
        // antispam de WhatsApp (mandar 100 mensajes de golpe es bloqueo seguro)
        if (s.demora) await dormir(s.demora);

        const jid = jidDe(s.para);
        if (respondiendo && s.para === respondiendo) await escribiendo(jid, s.texto);
        if (s.imagenRuta && fs.existsSync(s.imagenRuta)) {
          recordarEnviado(await sock.sendMessage(jid, { image: fs.readFileSync(s.imagenRuta), caption: s.texto }));
        } else if (s.adjunto && fs.existsSync(s.adjunto.ruta)) {
          recordarEnviado(await sock.sendMessage(jid, {
            document: fs.readFileSync(s.adjunto.ruta),
            mimetype: s.adjunto.mime || 'application/octet-stream',
            fileName: s.adjunto.nombre || 'archivo',
            caption: s.texto,
          }));
        } else {
          await enviarTexto(jid, s, conEncuesta);
        }
        // El pin del local, después de la dirección escrita (`src/mapa.js`).
        if (s.ubicacion) {
          try {
            recordarEnviado(await sock.sendMessage(jid, {
              location: {
                degreesLatitude: s.ubicacion.lat, degreesLongitude: s.ubicacion.lng,
                name: s.ubicacion.nombre, address: s.ubicacion.direccion,
              },
            }));
          } catch (e) { console.error(`No salió el pin del local a ${s.para}:`, e.message); }
        }
        enviados.push(s);
      } catch (e) {
        console.error(`No pude enviar a ${s.para}:`, e.message);
      }
    }
    if (respondiendo) sock.sendPresenceUpdate('paused', jidDe(respondiendo)).catch(() => {});
    return enviados;
  }

  return {
    iniciar: () => conectar().catch((e) => { console.error('Baileys no pudo iniciar:', e.message); process.exit(1); }),
    enviar: enviarTodos,
    cerrar: () => { cerrando = true; sock?.end?.(); },
  };
}

module.exports = { crearAdaptador };
