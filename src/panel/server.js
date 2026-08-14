// Panel de estado en localhost del mismo celu: estado, uptime, últimos eventos
// y botón de reinicio (pm2 restart bot-turnos). No se expone a internet;
// para soporte remoto se entra por Tailscale + SSH y se abre con curl o
// port-forward.
const express = require('express');
const { execFile } = require('child_process');
const qEventos = require('../db/consultas/eventos');
const qTurnos = require('../db/consultas/turnos');
const fechas = require('../core/fechas');

function iniciarPanel(config, obtenerEstado) {
  const app = express();

  app.get('/', (_req, res) => {
    const e = obtenerEstado();
    const eventos = qEventos.ultimos(15);
    const turnosHoy = qTurnos.delDia(fechas.hoyYmd());
    const upHoras = (process.uptime() / 3600).toFixed(1);
    res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${config.negocio.nombre} — panel</title>
<style>
  body{font-family:system-ui,sans-serif;margin:1rem;background:#111;color:#eee;max-width:600px}
  .ok{color:#4caf50}.mal{color:#f44336}
  table{border-collapse:collapse;width:100%;font-size:.85rem}
  td,th{border:1px solid #333;padding:.3rem .5rem;text-align:left}
  button{background:#f44336;color:#fff;border:0;padding:.6rem 1.2rem;border-radius:6px;font-size:1rem}
</style></head><body>
<h2>🤖 ${config.negocio.nombre}</h2>
<p>WhatsApp: <b class="${e.conectado ? 'ok' : 'mal'}">${e.conectado ? 'conectado ✔' : 'DESCONECTADO ✘'}</b>
 &nbsp;|&nbsp; uptime: ${upHoras} hs &nbsp;|&nbsp; turnos hoy: ${turnosHoy.length}</p>
<form method="post" action="/reiniciar" onsubmit="return confirm('¿Reiniciar el bot?')">
  <button type="submit">Reiniciar bot</button>
</form>
<h3>Últimos eventos</h3>
<table><tr><th>Fecha</th><th>Tipo</th><th>Detalle</th></tr>
${eventos.map((ev) => `<tr><td>${ev.creado_en}</td><td>${ev.tipo}</td><td>${ev.detalle || ''}</td></tr>`).join('')}
</table></body></html>`);
  });

  app.post('/reiniciar', (_req, res) => {
    // shell:true para que Windows encuentre pm2.cmd si existiera
    execFile('pm2', ['restart', 'bot-turnos'], { shell: true }, (err) => {
      if (err) console.error('pm2 restart falló:', err.message);
    });
    // Si no hay PM2 (demo en PC con npm), avisamos en vez de mentir
    res.send(`Orden de reinicio enviada a PM2.<br>
      <b>Ojo:</b> este botón solo funciona en producción (celu con PM2).
      En la demo con <code>npm run baileys</code>, reiniciá desde la terminal (Ctrl+C y de nuevo el comando).<br>
      <a href="/">← volver</a>`);
  });

  app.get('/salud', (_req, res) => {
    res.json({ conectado: obtenerEstado().conectado, uptime_seg: Math.floor(process.uptime()) });
  });

  // Solo localhost: nada de exponer esto a la red.
  app.listen(config.panel.puerto, '127.0.0.1', () => {
    console.log(`Panel: http://localhost:${config.panel.puerto}`);
  });
}

module.exports = { iniciarPanel };
