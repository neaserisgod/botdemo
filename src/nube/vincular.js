// Vincular el bot a Nodo Sur desde el mismo celular, como "iniciar sesión en el navegador" (el mismo flujo que la PC y
// la app del celular, `NodoSurPage/functions/_lib/devices.js`):
//   1. el bot escucha en 127.0.0.1 un puerto libre;
//   2. abre en el navegador horsepos.com/vincular/?tipo=bot&… (con Termux:API, `termux-open-url`);
//   3. la persona entra con Google (el dueño o un encargado), elige la sucursal y confirma;
//   4. el sitio manda el navegador a 127.0.0.1/callback con un código de un solo uso;
//   5. el bot lo canjea por su token (PKCE: solo quien pidió el código lo puede canjear) y lo guarda en data/nodosur.json.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const cuentaArchivo = require('./cuenta');

const SITIO = process.env.NODOSUR_SITIO || 'https://horsepos.com';
const PLAZO_MS = 10 * 60 * 1000;
const b64u = (buf) => Buffer.from(buf).toString('base64url');

// El id de este equipo para Nodo Sur: el mismo de una vinculación a la otra (si se vuelve a vincular, no aparece otro bot).
function idDispositivo() {
  const ruta = path.join(cuentaArchivo.dirDatos(), 'dispositivo.json');
  try { return JSON.parse(fs.readFileSync(ruta, 'utf8')).id; } catch { /* primera vez */ }
  const id = `bot-${crypto.randomBytes(16).toString('hex')}`;
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(ruta, JSON.stringify({ id }));
  return id;
}

// Abre la dirección en el navegador del celular; en una PC, el navegador de siempre. Si no se puede, se muestra para copiarla.
function abrirEnNavegador(url) {
  return new Promise((resolve) => {
    execFile('termux-open-url', [url], (e) => {
      if (!e) return resolve(true);
      execFile(process.platform === 'win32' ? 'explorer' : 'xdg-open', [url], (e2) => resolve(!e2));
    });
  });
}

const PAGINA = (titulo, texto) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${titulo}</title><body style="font-family:sans-serif;padding:24px;max-width:520px;margin:auto"><h1>${titulo}</h1><p>${texto}</p></body>`;

function vincular({ sitio = SITIO, nombre = 'Bot de WhatsApp', abrir = abrirEnNavegador, fetch = globalThis.fetch, cuenta = cuentaArchivo, alMostrar = console.log } = {}) {
  const verifier = b64u(crypto.randomBytes(48));
  const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
  const state = b64u(crypto.randomBytes(24));
  const deviceId = idDispositivo();

  return new Promise((resolve, reject) => {
    let terminado = false;
    const servidor = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') { res.writeHead(404); return res.end(); }
      const code = u.searchParams.get('code');
      if (u.searchParams.get('state') !== state || !code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(PAGINA('No se pudo vincular', 'El enlace no es de esta vinculación. Volvé a empezar desde Termux.'));
      }
      try {
        const r = await fetch(`${sitio}/api/device/token`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, verifier }), signal: AbortSignal.timeout(20000),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.token) throw new Error(`el sitio contestó ${r.status}${j.error ? ` (${j.error})` : ''}`);
        let yo = {};
        try {
          const m = await fetch(`${sitio}/api/device/me`, { headers: { Authorization: `Bearer ${j.token}` }, signal: AbortSignal.timeout(20000) });
          if (m.ok) yo = await m.json();
        } catch { /* se completa en la próxima vuelta */ }
        cuenta.guardar({ sitio, token: j.token, deviceId, email: j.email, nombre: yo.name || null, orgId: yo.orgId ?? null, branchId: yo.branchId ?? null,
          vinculadoEn: new Date().toISOString(), cursorPedidos: 0 });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGINA('¡Listo!', 'El bot quedó vinculado a tu negocio. Ya podés volver a Termux.'));
        terminar(null, { email: j.email, orgId: yo.orgId ?? null, branchId: yo.branchId ?? null });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGINA('No se pudo vincular', 'Algo falló al terminar. Volvé a Termux y probá de nuevo.'));
        terminar(e);
      }
    });

    const plazo = setTimeout(() => terminar(new Error('pasaron 10 minutos sin terminar la vinculación')), PLAZO_MS);
    function terminar(error, resultado) {
      if (terminado) return;
      terminado = true;
      clearTimeout(plazo);
      servidor.close();
      if (error) reject(error); else resolve(resultado);
    }

    servidor.listen(0, '127.0.0.1', async () => {
      const port = servidor.address().port;
      const q = new URLSearchParams({ port: String(port), state, challenge, device: deviceId, name: nombre, tipo: 'bot' });
      const url = `${sitio}/vincular/?${q}`;
      const abierto = await abrir(url);
      alMostrar(abierto
        ? '\nSe abrió el navegador: entrá con la cuenta de Google del negocio, elegí la sucursal y tocá "Vincular".'
        : '\nAbrí esta dirección en el navegador del celular:');
      alMostrar(`${url}\n`);
    });
  });
}

module.exports = { vincular, idDispositivo, SITIO };
