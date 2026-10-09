// El bot con Nodo Sur (sitio horsepos.com, `/api/bot/*`). Corre aparte del núcleo: la conversación nunca espera a la red.
//
//  * Configuración: la del negocio, cargada desde la app de Nodo Sur. Se guarda en data/config-nube.json (una capa de
//    `config.js`) y se recarga sin reiniciar. Si lo que llega no pasa la validación, se vuelve a la anterior.
//  * Catálogo (solo comercios): lo que publica la app para contestar precio y si hay. Se guarda en data/catalogo.json para
//    arrancar sin internet.
//  * Pedidos (solo comercios): la bandeja local (`pedidos`) se manda al sitio, y cuando el local los acepta o rechaza en la
//    app el bot le avisa al cliente. Reintentar no duplica nada: el pedido lleva su id, y un pedido ya resuelto no cambia.
//  * Avisos en vivo: el mismo WebSocket de la sync (`/api/sync/escuchar`); el sitio le manda al bot solo lo suyo. Sin
//    conexión de avisos se revisa igual cada 10 minutos.
const fs = require('fs');
const path = require('path');
const catalogo = require('../core/catalogo');
const comercio = require('../core/comercio');
const qPedidos = require('../db/consultas/pedidos');
const { textoPeso } = require('../core/diccionario/numeros');
const { rutaNube, configNube } = require('../config');
const cuentaArchivo = require('./cuenta');

const CADA_MS = 10 * 60 * 1000;
const PING_MS = 60 * 60 * 1000;
const rutaCatalogo = () => path.join(cuentaArchivo.dirDatos(), 'catalogo.json');

function escribirAtomico(ruta, datos) {
  fs.mkdirSync(path.dirname(ruta), { recursive: true });
  fs.writeFileSync(`${ruta}.tmp`, JSON.stringify(datos));
  fs.renameSync(`${ruta}.tmp`, ruta);
}

// Lo último que se bajó, para atender aunque el celular arranque sin internet.
function cargarCatalogoGuardado() {
  try {
    const c = JSON.parse(fs.readFileSync(rutaCatalogo(), 'utf8'));
    catalogo.fijar(c.items || [], c.actualizado ?? null);
    return true;
  } catch { return false; }
}

function crearSincronizador({ config, cliente, cuenta = cuentaArchivo, recargarConfig, enviar, version = '0', log = console }) {
  const esComercio = () => config.forma === 'productos';

  async function traerConfig() {
    const r = await cliente.config();
    if (!r || !r.config) return false; // todavía no se configuró desde la app: sigue config.json
    const actual = configNube();
    if (actual && actual.version === r.version) return false;
    const previo = fs.existsSync(rutaNube()) ? fs.readFileSync(rutaNube(), 'utf8') : null;
    escribirAtomico(rutaNube(), { version: r.version, config: r.config });
    const problemas = recargarConfig();
    if (problemas.length) {
      // Volver a lo anterior: si quedara guardada, el bot no podría ni arrancar.
      if (previo === null) fs.unlinkSync(rutaNube()); else escribirAtomico(rutaNube(), JSON.parse(previo));
      log.error(`La configuración de Nodo Sur (versión ${r.version}) no sirve, sigo con la anterior:\n  • ${problemas.join('\n  • ')}`);
      return false;
    }
    log.log(`Configuración de Nodo Sur aplicada (versión ${r.version}).`);
    return true;
  }

  async function traerCatalogo() {
    if (!esComercio()) return false;
    const r = await cliente.catalogo();
    escribirAtomico(rutaCatalogo(), { items: r.items || [], actualizado: r.actualizado ?? null });
    catalogo.fijar(r.items || [], r.actualizado ?? null);
    return true;
  }

  // Lo que se pesa viaja en gramos: `{ gid, nombre, gramos, precioCentavos }` con el precio POR KILO. El sitio de hoy
  // solo acepta `cantidad` entera, que para un pesable la app toma como KILOS (`apartadosDePedido`, Nodo-Sur-Pos). Si
  // el sitio rechaza los gramos, se manda como antes: los kilos enteros como cantidad, y si queda algo que no entra
  // (250 g), el pedido le llega al local por WhatsApp (ver `aMano`). Se vuelve a probar con gramos cada vez que arranca.
  let sitioConGramos = true;
  function cuerpoPedido(p, conGramos) {
    const items = [], sueltos = [];
    for (const x of p.datos.items) {
      const base = { gid: x.gid, nombre: x.nombre, precioCentavos: x.precioCentavos };
      if (!x.gramos) items.push({ ...base, cantidad: x.cantidad });
      else if (conGramos) items.push({ ...base, gramos: x.gramos });
      else if (x.gramos % 1000 === 0) items.push({ ...base, cantidad: x.gramos / 1000 });
      else sueltos.push(x);
    }
    return { envio: { id: p.pedido_id, cliente: p.datos.cliente, items, ...(p.datos.nota ? { nota: p.datos.nota } : {}) }, sueltos };
  }

  // Lo manda y devuelve lo que contestó el sitio, o null si con el sitio de hoy no se puede (gramos sueltos).
  async function mandarUno(p) {
    if (sitioConGramos) {
      try {
        return await cliente.mandarPedido(cuerpoPedido(p, true).envio);
      } catch (e) {
        if (!(e.status === 400 && p.datos.items.some((x) => x.gramos))) throw e;
        sitioConGramos = false;
        log.log('Nodo Sur todavía no recibe pedidos en gramos: mando los kilos enteros y lo demás por WhatsApp.');
      }
    }
    const { envio, sueltos } = cuerpoPedido(p, false);
    if (sueltos.length || !envio.items.length) return null;
    return cliente.mandarPedido(envio);
  }

  // El pedido que Nodo Sur no puede recibir todavía (gramos sueltos): al dueño por WhatsApp, entero, para que lo prepare y
  // le conteste al cliente directo. Si WhatsApp no está, queda en la bandeja para la próxima vuelta.
  async function aMano(p) {
    const lineas = p.datos.items.map((x) => `• ${x.gramos ? `${textoPeso(x.gramos)} de ${catalogo.nombreCorto(x)}` : `${x.cantidad} × ${x.nombre}`}`).join('\n');
    const c = p.datos.cliente;
    const enviados = await enviar([{ para: config.numero_duena,
      texto: `🛒 *Pedido por WhatsApp* (para retirar)\n${c.nombre} — ${c.telefono}\n\n${lineas}\n\nLleva cosas por gramos y Nodo Sur todavía no las recibe: no está en Encargues. Preparalo y avisale a ${c.nombre} directo por acá.` }]);
    if (!enviados || !enviados.length) return false;
    qPedidos.marcarAMano(p.id);
    return true;
  }

  async function mandarBandeja() {
    let mandados = 0;
    for (const p of qPedidos.porEnviar()) {
      try {
        const r = await mandarUno(p);
        if (r) qPedidos.marcarEnviado(p.id, r.id);
        if (r || await aMano(p)) mandados++;
      } catch (e) {
        // Sin red o el sitio caído: queda en la bandeja para la próxima vuelta. Un 400 sería un pedido que el sitio no
        // acepta nunca: se avisa en el log para revisarlo a mano.
        log.error(`No pude mandar el pedido ${p.pedido_id} a Nodo Sur: ${e.message}`);
        if (!e.status || e.status >= 500) break;
      }
    }
    return mandados;
  }

  async function revisarPedidos() {
    let desde = (cuenta.leer() || {}).cursorPedidos || 0;
    for (;;) {
      const r = await cliente.pedidos(desde);
      for (const p of r.pedidos || []) {
        if (p.estado !== 'aceptado' && p.estado !== 'rechazado') continue;
        const local = qPedidos.porRemotoId(p.id);
        if (local) qPedidos.resolver(local.id, p.estado);
      }
      desde = r.hasta ?? desde;
      cuenta.actualizar({ cursorPedidos: desde });
      if (!r.mas) break;
    }
    return avisarResueltos();
  }

  // Le avisa al cliente cómo se resolvió su pedido. Se marca recién cuando el mensaje salió: si WhatsApp está caído,
  // se reintenta en la próxima vuelta.
  async function avisarResueltos() {
    let avisados = 0;
    for (const p of qPedidos.sinAvisar()) {
      const enviados = await enviar([comercio.avisoDePedido(config, p, p.estado)]);
      if (enviados && enviados.length) { qPedidos.marcarAvisado(p.id); avisados++; }
    }
    return avisados;
  }

  async function ping() {
    const r = await cliente.ping(version);
    if (r && r.token) cuenta.actualizar({ token: r.token }); // el sitio lo renueva cuando le quedan menos de 60 días
  }

  // Una vuelta entera. Cada parte por separado: que falle una no frena las demás.
  async function vuelta() {
    for (const [nombre, paso] of [['configuración', traerConfig], ['catálogo', traerCatalogo]]) {
      try { await paso(); } catch (e) { reportar(nombre, e); }
    }
    if (esComercio()) {
      try { await mandarBandeja(); } catch (e) { reportar('pedidos', e); }
      try { await revisarPedidos(); } catch (e) { reportar('pedidos', e); }
    }
  }

  let avisoDesvinculado = false;
  function reportar(que, e) {
    if (e && e.desvinculado) {
      if (!avisoDesvinculado) log.error('Nodo Sur: este bot ya no está vinculado. Volvé a vincularlo con: bash bot.sh vincular-nodosur');
      avisoDesvinculado = true;
    } else if (e && e.sinPlan) {
      log.error('Nodo Sur: el negocio no tiene un plan con bot, así que no baja la configuración ni los pedidos.');
    } else {
      log.error(`Nodo Sur (${que}): ${e && e.message}`);
    }
  }

  // Lo que manda el sitio por el WebSocket: `{ bot: { config | catalogo | pedido, estado } }`. Cualquier otra cosa se ignora.
  async function alAviso(texto) {
    let m;
    try { m = JSON.parse(texto); } catch { return; }
    const a = m && m.bot;
    if (!a) return;
    try {
      if (a.config !== undefined) await traerConfig();
      if (a.catalogo) await traerCatalogo();
      if (a.pedido !== undefined && a.estado) await revisarPedidos();
    } catch (e) { reportar('aviso', e); }
  }

  // Escucha los avisos del sitio y se reconecta solo, cada vez más espaciado (5 s → 5 min).
  let ws = null, parado = false, timers = [];
  function escuchar(WebSocket, intento = 0) {
    if (parado || !WebSocket) return;
    try {
      ws = new WebSocket(cliente.urlEscucha(), { headers: { Authorization: `Bearer ${cliente.token}` } });
    } catch (e) { reportar('avisos', e); return reintentar(WebSocket, intento); }
    ws.on('open', () => { intento = 0; vuelta(); }); // ponerse al día de lo que pasó sin escuchar
    ws.on('message', (d) => alAviso(String(d)));
    ws.on('close', () => reintentar(WebSocket, intento));
    ws.on('error', () => { /* el 'close' que sigue reintenta */ });
  }
  function reintentar(WebSocket, intento) {
    if (parado) return;
    const espera = [5000, 20000, 60000, 300000][Math.min(intento, 3)];
    timers.push(setTimeout(() => escuchar(WebSocket, intento + 1), espera));
  }

  function iniciar({ WebSocket } = {}) {
    parado = false;
    vuelta();
    ping().catch((e) => reportar('ping', e));
    timers.push(setInterval(vuelta, CADA_MS), setInterval(() => ping().catch((e) => reportar('ping', e)), PING_MS));
    escuchar(WebSocket);
  }

  function detener() {
    parado = true;
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    timers = [];
    if (ws) try { ws.close(); } catch { /* ya cerrado */ }
  }

  return { traerConfig, traerCatalogo, mandarBandeja, revisarPedidos, avisarResueltos, ping, vuelta, alAviso, iniciar, detener };
}

module.exports = { crearSincronizador, cargarCatalogoGuardado, rutaCatalogo };
