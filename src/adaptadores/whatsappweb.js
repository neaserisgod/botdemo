// Adaptador whatsapp-web.js — SOLO para la demo en PC (usa Chromium).
// En el celu (fase 2) se reemplaza por el adaptador Baileys; el núcleo no cambia.
const fs = require('fs');
const path = require('path');

function crearAdaptador(config, hooks) {
  // require adentro de la función: así el núcleo y los tests no lo cargan.
  const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
  const qrcode = require('qrcode-terminal');

  const dirMedia = path.join(__dirname, '..', '..', 'data', 'comprobantes');
  fs.mkdirSync(dirMedia, { recursive: true });

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(__dirname, '..', '..', 'data', 'sesion') }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
  });

  client.on('qr', (qr) => {
    console.log('Escaneá este QR con el WhatsApp de la demo:');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => hooks.alConectar());
  client.on('disconnected', (motivo) => hooks.alDesconectar(String(motivo)));

  client.on('message', async (msg) => {
    try {
      if (msg.from.endsWith('@g.us')) return; // grupos: ignorar
      const de = msg.from.replace('@c.us', '');

      // Foto (comprobante): la bajamos a disco para el OCR.
      let rutaImagen = null;
      if (msg.hasMedia && ['image'].includes(msg.type)) {
        const media = await msg.downloadMedia();
        if (media) {
          const ext = (media.mimetype || 'image/jpeg').split('/')[1].split(';')[0];
          rutaImagen = path.join(dirMedia, `${de}_${Date.now()}.${ext}`);
          fs.writeFileSync(rutaImagen, Buffer.from(media.data, 'base64'));
        }
      }

      // Ítem de catálogo tocado (productMessage). En whatsapp-web.js llega como
      // type 'product'; en Baileys será message.productMessage.product.productId.
      let productoId = null;
      if (msg.type === 'product' && msg.rawData) {
        productoId = msg.rawData.productId || null;
      }

      const salientes = hooks.alRecibir({ de, texto: msg.body || '', rutaImagen, productoId });
      await enviarTodos(salientes);
    } catch (e) {
      console.error('Error procesando mensaje:', e.message);
    }
  });

  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  async function enviarTodos(salientes) {
    for (const s of salientes || []) {
      try {
        if (s.demora) await dormir(s.demora); // envíos masivos espaciados
        const jid = `${s.para}@c.us`;
        if (s.imagenRuta && fs.existsSync(s.imagenRuta)) {
          const media = MessageMedia.fromFilePath(s.imagenRuta);
          await client.sendMessage(jid, media, { caption: s.texto });
        } else if (s.adjunto && fs.existsSync(s.adjunto.ruta)) {
          const media = MessageMedia.fromFilePath(s.adjunto.ruta);
          await client.sendMessage(jid, media, { caption: s.texto, sendMediaAsDocument: true });
        } else {
          await client.sendMessage(jid, s.texto);
        }
      } catch (e) {
        console.error(`No pude enviar a ${s.para}:`, e.message);
      }
    }
  }

  return {
    iniciar: () => client.initialize(),
    enviar: enviarTodos,
  };
}

module.exports = { crearAdaptador };
