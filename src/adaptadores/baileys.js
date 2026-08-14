// Adaptador Baileys — producción (celu con Termux) y también anda en PC.
// Sin Chromium: se conecta directo al protocolo de WhatsApp Web.
// Sesión propia en data/sesion-baileys/ (NO toca la sesión de otro bot:
// vincular acá agrega un dispositivo nuevo a la cuenta, no desloguea nada).
const fs = require('fs');
const path = require('path');

function crearAdaptador(config, hooks) {
  const baileys = require('@whiskeysockets/baileys');
  const makeWASocket = baileys.default || baileys.makeWASocket;
  const { useMultiFileAuthState, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion } = baileys;
  const qrcode = require('qrcode-terminal');
  const pino = require('pino'); // viene como dependencia de baileys

  const dirSesion = path.join(__dirname, '..', '..', 'data', 'sesion-baileys');
  const dirMedia = path.join(__dirname, '..', '..', 'data', 'comprobantes');
  fs.mkdirSync(dirMedia, { recursive: true });

  const logger = pino({ level: 'silent' }); // el ruido de baileys no nos sirve
  let sock = null;
  let cerrando = false;

  // Chats nuevos con @lid: guardamos a qué JID responderle a cada número.
  const jidPorNumero = new Map();
  const jidDe = (numero) => jidPorNumero.get(numero) || `${numero}@s.whatsapp.net`;

  // Mapeo LID → número real, persistido en disco: WhatsApp a veces manda el
  // mensaje identificado con un ID interno (@lid) SIN el número real adjunto.
  // Si no lo resolvemos, la dueña cae al flujo de clienta. Con que una vez
  // llegue el número real, lo recordamos para siempre.
  const rutaLidMap = path.join(__dirname, '..', '..', 'data', 'lid-map.json');
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
    const { state, saveCreds } = await useMultiFileAuthState(dirSesion);
    // Versión de protocolo actual: evita el clásico "connection closed" por versión vieja
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* usa la default */ }

    sock = makeWASocket({
      auth: state,
      version,
      logger,
      markOnlineOnConnect: false, // no pisar las notificaciones del celu de la dueña
      syncFullHistory: false,     // celus de 2-3 GB: nada de bajar historial
    });

    sock.ev.on('creds.update', saveCreds);

    // Emparejamiento por CÓDIGO (para el celu: no podés escanear el QR de tu
    // propia pantalla). Corré con --pareo y meté el código en el WhatsApp del
    // bot: Dispositivos vinculados > Vincular con el número de teléfono.
    if (!state.creds.registered && (process.argv.includes('--pareo') || process.env.PAREO)) {
      setTimeout(async () => {
        try {
          const codigo = await sock.requestPairingCode(config.numero_actual);
          console.log('==========================================');
          console.log(`  CÓDIGO DE VINCULACIÓN: ${codigo}`);
          console.log(`  (para el número ${config.numero_actual})`);
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
      if (connection === 'open') hooks.alConectar();
      if (connection === 'close') {
        const codigo = lastDisconnect?.error?.output?.statusCode;
        const deslogueado = codigo === DisconnectReason.loggedOut;
        hooks.alDesconectar(`baileys close (código ${codigo ?? '?'})`);
        if (deslogueado) {
          console.error('Sesión cerrada desde el teléfono. Borrá data/sesion-baileys y re-escaneá el QR.');
          return;
        }
        if (!cerrando) {
          console.log('Reconectando en 5 s...');
          setTimeout(() => conectar().catch((e) => console.error('Reconexión falló:', e.message)), 5000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return; // solo mensajes nuevos, no historial
      for (const msg of messages) {
        try {
          await procesarEntrante(msg);
        } catch (e) {
          console.error('Error procesando mensaje:', e.message);
        }
      }
    });
  }

  async function procesarEntrante(msg) {
    if (!msg.message || msg.key.fromMe) return;
    const remoteJid = msg.key.remoteJid || '';
    if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') return;

    // Chats @lid: buscar el número real en (1) senderPn del mensaje,
    // (2) el mapeo guardado, (3) el resolvedor interno de baileys.
    let jidNumero = remoteJid;
    if (remoteJid.endsWith('@lid')) {
      const lid = remoteJid.split('@')[0].split(':')[0];
      const pnDelMsj = msg.key.senderPn || msg.key.participantPn || msg.key.remoteJidAlt;
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

    const m = msg.message;
    const texto = m.conversation
      || m.extendedTextMessage?.text
      || m.imageMessage?.caption
      || '';
    if (process.env.DEPURAR) console.log(`[msj] de=${de} jid=${remoteJid} texto="${texto.slice(0, 40)}"`);

    // Foto (comprobante): bajar a disco para el OCR con tesseract
    let rutaImagen = null;
    if (m.imageMessage) {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
        logger, reuploadRequest: sock.updateMediaMessage,
      });
      rutaImagen = path.join(dirMedia, `${de}_${Date.now()}.jpg`);
      fs.writeFileSync(rutaImagen, buffer);
    }

    // Ítem del catálogo tocado por la clienta
    const productoId = m.productMessage?.product?.productId || null;

    const salientes = hooks.alRecibir({ de, texto, rutaImagen, productoId });
    await enviarTodos(salientes);
  }

  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  async function enviarTodos(salientes) {
    for (const s of salientes || []) {
      try {
        // demora: los envíos masivos van espaciados para no disparar el
        // antispam de WhatsApp (mandar 100 mensajes de golpe es bloqueo seguro)
        if (s.demora) await dormir(s.demora);

        const jid = jidDe(s.para);
        if (s.imagenRuta && fs.existsSync(s.imagenRuta)) {
          await sock.sendMessage(jid, { image: fs.readFileSync(s.imagenRuta), caption: s.texto });
        } else if (s.adjunto && fs.existsSync(s.adjunto.ruta)) {
          await sock.sendMessage(jid, {
            document: fs.readFileSync(s.adjunto.ruta),
            mimetype: s.adjunto.mime || 'application/octet-stream',
            fileName: s.adjunto.nombre || 'archivo',
            caption: s.texto,
          });
        } else {
          await sock.sendMessage(jid, { text: s.texto });
        }
      } catch (e) {
        console.error(`No pude enviar a ${s.para}:`, e.message);
      }
    }
  }

  return {
    iniciar: () => conectar().catch((e) => { console.error('Baileys no pudo iniciar:', e.message); process.exit(1); }),
    enviar: enviarTodos,
    cerrar: () => { cerrando = true; sock?.end?.(); },
  };
}

module.exports = { crearAdaptador };
