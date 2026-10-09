// Simulador: probar el bot desde el navegador, sin WhatsApp y sin tres celulares. Escribís como cliente o como dueña con
// un botón y ves lo que contesta el bot, con la configuración y el catálogo de verdad de este equipo.
//
//   bash bot.sh probar        (en el celular, en otra sesión de Termux: el bot puede seguir andando)
//   npm run probar            (en una PC)
//
// No toca nada real: usa una base de datos de prueba (en la carpeta temporal, se borra al cerrar), no manda nada a
// WhatsApp ni a Nodo Sur (un pedido de prueba no le llega al local) y no le saca el lugar al bot que está andando.
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUTA_DB = path.join(os.tmpdir(), `bot_prueba_${process.pid}.db`);
process.env.RUTA_DB = RUTA_DB;

const express = require('express');
const configuracion = require('../src/config');
const db = require('../src/db');
const catalogo = require('../src/core/catalogo');
const { crearMotor } = require('../src/core/motor');
const qNoEntendidos = require('../src/db/consultas/noEntendidos');

// Arma el simulador sobre una configuración ya cargada. Devuelve la app de Express (los tests la usan sin abrir puerto).
function crearSimulador(config) {
  const motor = crearMotor(config);
  let numero = 0;
  const nuevoCliente = () => `54900000${String(++numero).padStart(5, '0')}`;
  let cliente = nuevoCliente();

  // A quién le habla el bot en cada mensaje, en palabras.
  const quien = (para) => (para === cliente ? 'cliente' : para === config.numero_duena ? 'duena' : para === config.numero_soporte ? 'soporte' : 'otro');

  const app = express();
  app.use(express.json({ limit: '16kb' }));

  app.get('/', (_req, res) => res.type('html').send(PAGINA(config)));

  // { como: 'cliente' | 'duena', texto } → lo que contestó el bot, a quién.
  app.post('/mensaje', (req, res) => {
    const { como, texto } = req.body || {};
    if (typeof texto !== 'string' || !texto.trim() || texto.length > 2000) return res.status(400).json({ error: 'texto' });
    const de = como === 'duena' ? config.numero_duena : cliente;
    let salientes;
    try {
      salientes = motor.procesarMensaje({ de, texto });
    } catch (e) {
      // Un error del bot se muestra en la pantalla (es justo lo que hay que ver al probar).
      return res.json({ respuestas: [{ a: 'error', texto: `El bot falló: ${e.message}` }] });
    }
    res.json({ respuestas: (salientes || []).map((s) => ({ a: quien(s.para), texto: s.texto || '', adjunto: s.adjunto?.nombre || null })) });
  });

  // Otra charla desde cero: un cliente nuevo (sin nombre, sin turnos, sin pausa).
  app.post('/nuevo', (_req, res) => { cliente = nuevoCliente(); res.json({ ok: true }); });

  app.get('/no-entendidos', (_req, res) => res.json(qNoEntendidos.ultimos(30)));

  return app;
}

const escapar = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PAGINA = (config) => `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Probar el bot — ${escapar(config.negocio.nombre)}</title>
<style>
  :root{--fondo:#efeae2;--yo:#d9fdd3;--bot:#fff;--duena:#fff4d6;--texto:#111;--suave:#667781;--barra:#008069}
  @media (prefers-color-scheme:dark){:root{--fondo:#0b141a;--yo:#005c4b;--bot:#202c33;--duena:#3b3320;--texto:#e9edef;--suave:#8696a0;--barra:#202c33}}
  *{box-sizing:border-box} body{margin:0;font-family:system-ui,sans-serif;background:var(--fondo);color:var(--texto);height:100dvh;display:flex;flex-direction:column}
  header{background:var(--barra);color:#fff;padding:10px 12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  header b{flex:1;min-width:140px;font-size:15px}
  button{border:0;border-radius:18px;padding:8px 12px;font-size:14px;cursor:pointer}
  .rol{background:rgba(255,255,255,.18);color:#fff} .rol.activo{background:#fff;color:#008069;font-weight:600}
  .chico{background:rgba(255,255,255,.18);color:#fff;font-size:13px}
  #chat{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:6px}
  .m{max-width:85%;padding:7px 10px;border-radius:8px;white-space:pre-wrap;word-wrap:break-word;font-size:15px;line-height:1.35;box-shadow:0 1px .5px rgba(0,0,0,.13)}
  .yo{align-self:flex-end;background:var(--yo)} .bot{align-self:flex-start;background:var(--bot)}
  .duena{align-self:flex-start;background:var(--duena)} .error{align-self:center;background:#fdd;color:#900}
  .quien{display:block;font-size:12px;color:var(--suave);margin-bottom:2px}
  .aviso{align-self:center;font-size:12px;color:var(--suave);text-align:center;padding:4px 8px}
  form{display:flex;gap:8px;padding:8px;background:var(--fondo)}
  input{flex:1;border:0;border-radius:20px;padding:10px 14px;font-size:16px;background:var(--bot);color:var(--texto)}
  form button{background:#00a884;color:#fff;font-weight:600}
</style></head><body>
<header><b>🧪 Probar: ${escapar(config.negocio.nombre)}</b>
  <button class="rol activo" data-como="cliente">Soy cliente</button>
  <button class="rol" data-como="duena">Soy la dueña</button>
  <button class="chico" id="nuevo">Charla nueva</button>
  <button class="chico" id="noent">No entendió</button></header>
<div id="chat"><div class="aviso">Prueba: nada de esto sale por WhatsApp ni llega a Nodo Sur.<br>Escribí como un cliente; con «Soy la dueña» probás sus comandos.</div></div>
<form id="f"><input id="t" autocomplete="off" placeholder="Escribí un mensaje" autofocus><button>Enviar</button></form>
<script>
  let como = 'cliente';
  const chat = document.getElementById('chat'), t = document.getElementById('t');
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  // Las negritas y cursivas de WhatsApp.
  const formato = (s) => esc(s).replace(/\\*([^*\\n]+)\\*/g, '<b>$1</b>').replace(/(^|\\s)_([^_\\n]+)_/g, '$1<i>$2</i>');
  function burbuja(clase, texto, quien) {
    const d = document.createElement('div');
    d.className = 'm ' + clase;
    d.innerHTML = (quien ? '<span class="quien">' + esc(quien) + '</span>' : '') + formato(texto);
    chat.appendChild(d); chat.scrollTop = chat.scrollHeight;
  }
  const aviso = (texto) => { const d = document.createElement('div'); d.className = 'aviso'; d.textContent = texto; chat.appendChild(d); chat.scrollTop = chat.scrollHeight; };
  document.querySelectorAll('.rol').forEach((b) => b.onclick = () => {
    como = b.dataset.como;
    document.querySelectorAll('.rol').forEach((x) => x.classList.toggle('activo', x === b));
    aviso(como === 'duena' ? 'Ahora escribís como la dueña' : 'Ahora escribís como el cliente'); t.focus();
  });
  document.getElementById('nuevo').onclick = async () => { await fetch('nuevo', { method: 'POST' }); chat.innerHTML = ''; aviso('Charla nueva: un cliente que nunca escribió.'); t.focus(); };
  document.getElementById('noent').onclick = async () => {
    const l = await (await fetch('no-entendidos')).json();
    burbuja('bot', l.length ? l.map((x) => '• "' + x.texto + '"' + (x.veces > 1 ? ' (×' + x.veces + ')' : '')).join('\\n') : 'Todavía nada.', '🤔 Lo que no entendió en esta prueba');
  };
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const texto = t.value.trim(); if (!texto) return;
    t.value = '';
    burbuja('yo', texto, como === 'duena' ? 'Vos (dueña)' : 'Vos (cliente)');
    try {
      const r = await (await fetch('mensaje', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ como, texto }) })).json();
      if (!r.respuestas.length) aviso('(el bot no contestó)');
      for (const x of r.respuestas) {
        const adj = x.adjunto ? '\\n📎 ' + x.adjunto : '';
        if (x.a === 'error') burbuja('error', x.texto);
        else if (x.a === 'cliente') burbuja('bot', x.texto + adj, como === 'duena' ? 'Bot → al cliente' : 'Bot');
        else if (x.a === 'duena') burbuja('duena', x.texto + adj, 'Bot → a la dueña');
        else burbuja('duena', x.texto + adj, 'Bot → ' + x.a);
      }
    } catch { burbuja('error', 'No pude hablar con el simulador: ¿se cerró Termux?'); }
    t.focus();
  };
</script></body></html>`;

if (require.main === module) {
  const config = configuracion.cargar();
  db.abrir(RUTA_DB);
  db.sembrarServicios(config.servicios || []);
  const conCatalogo = require('../src/nube/sincronizar').cargarCatalogoGuardado();
  if (config.forma === 'productos' && !conCatalogo) {
    console.log('⚠️  No hay catálogo de Nodo Sur guardado en este equipo: el bot va a decir que no tiene la lista de precios.');
  } else if (config.forma === 'productos') {
    console.log(`Catálogo: ${catalogo.todos().length} productos.`);
  }
  const borrar = () => { for (const f of [RUTA_DB, `${RUTA_DB}-wal`, `${RUTA_DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* ya no está */ } } };
  process.on('exit', borrar);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  const puerto = Number(process.env.PUERTO_PRUEBA) || (config.panel?.puerto || 3010) + 1;
  crearSimulador(config).listen(puerto, '127.0.0.1', () => {
    const url = `http://localhost:${puerto}`;
    console.log(`\n🧪 Simulador listo: ${url}\n   Abrilo en el navegador de este mismo equipo. Para cerrarlo: Ctrl+C.\n`);
    require('child_process').execFile('termux-open-url', [url], () => {});
  }).on('error', (e) => {
    console.error(`No pude abrir el simulador en el puerto ${puerto} (${e.code}). Probá: PUERTO_PRUEBA=3020 bash bot.sh probar`);
    process.exit(1);
  });
}

module.exports = { crearSimulador };
