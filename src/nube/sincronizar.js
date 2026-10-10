// El bot con Nodo Sur (sitio horsepos.com, `/api/bot/*`). Corre aparte del núcleo: la conversación nunca espera a la red.
//
//  * Configuración: la del negocio, cargada desde la app de Nodo Sur. Se guarda en data/config-nube.json (una capa de
//    `config.js`) y se recarga sin reiniciar. Si lo que llega no pasa la validación, se vuelve a la anterior.
//  * Catálogo (solo comercios): lo que publica la app para contestar precio y si hay. Se guarda en data/catalogo.json para
//    arrancar sin internet.
//  * Pedidos (solo comercios): la bandeja local (`pedidos`) se manda al sitio, y cuando el local los acepta o rechaza en la
//    app el bot le avisa al cliente. Reintentar no duplica nada: el pedido lleva su id, y un pedido ya resuelto no cambia.
//  * Turnos (negocios de servicios): cada turno que da el bot se RESERVA en Nodo Sur (el sitio no deja que dos personas tomen
//    el mismo horario: si se le adelantaron, el bot le pide al cliente que elija otro) y entra a la Agenda de la app. Lo que
//    ocupa la agenda de la app se baja a `turnos_nube`, así el bot no ofrece un horario que dio la dueña. Si ella mueve,
//    cancela o anota la seña de un turno del bot en la app, el bot le avisa al cliente.
//  * Avisos en vivo: el mismo WebSocket de la sync (`/api/sync/escuchar`); el sitio le manda al bot solo lo suyo. Sin
//    conexión de avisos se revisa igual cada 10 minutos.
const fs = require('fs');
const path = require('path');
const catalogo = require('../core/catalogo');
const comercio = require('../core/comercio');
const qPedidos = require('../db/consultas/pedidos');
const qTurnos = require('../db/consultas/turnos');
const qSenas = require('../db/consultas/senas');
const fechas = require('../core/fechas');
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

  // Lo que se pesa viaja en gramos: `{ gid, nombre, gramos, precioCentavos }` con el precio POR KILO. El sitio los acepta
  // solo si todas las apps de la sucursal los entienden (`pedidoConGramosPermitido`, NodoSurPage; una app anterior
  // descartaba el pedido sin avisar). Si los rechaza, se manda como antes: los kilos enteros como `cantidad` (que la app
  // toma como kilos), y si queda algo que no entra (250 g), el pedido le llega al local por WhatsApp (ver `aMano`). Se
  // vuelve a probar con gramos una hora después: cuando actualizan la app, los pedidos solos pasan a entrar a Encargues.
  const REPROBAR_GRAMOS_MS = 60 * 60 * 1000;
  let gramosRechazadosEn = 0;
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
    if (Date.now() - gramosRechazadosEn >= REPROBAR_GRAMOS_MS) {
      try {
        return await cliente.mandarPedido(cuerpoPedido(p, true).envio);
      } catch (e) {
        if (!(e.status === 400 && p.datos.items.some((x) => x.gramos))) throw e;
        gramosRechazadosEn = Date.now();
        log.log('Nodo Sur todavía no recibe pedidos en gramos en esta sucursal (falta actualizar la app): mando los kilos enteros y lo demás por WhatsApp.');
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

  // --- Turnos ---------------------------------------------------------------------------------------------------------
  const esTurnos = () => config.forma !== 'productos';
  const ESTADO_EN_NUBE = {
    pendiente_sena: 'esperando_sena', confirmado: 'confirmado', completado: 'atendido', no_vino: 'no_vino',
    cancelado: 'cancelado', anulado: 'cancelado', vencido: 'cancelado', ocupado: 'cancelado',
  };
  const OCUPA_LOCAL = ['pendiente_sena', 'confirmado'];
  const ms = (texto) => fechas.deTexto(texto).getTime();
  const texto = (msEpoch) => fechas.aTexto(new Date(msEpoch));
  const cuando = (t) => `${fechas.diaLindo(t.inicio.slice(0, 10))} a las ${t.inicio.slice(11)}`;

  // Otro (un cliente por otro chat, o la dueña en la app) tomó ese horario un instante antes: el turno no vale y el cliente elige
  // otro. Si tenía una seña esperando, deja de esperarla.
  async function horarioOcupado(t) {
    qTurnos.cambiarEstado(t.id, 'ocupado', { desdeNube: true });
    qTurnos.marcarEnNube(t.id, { enviado: Boolean(t.nube_enviado) });
    const sena = qSenas.porTurno(t.id);
    if (sena && sena.estado === 'esperando_comprobante') qSenas.cambiarEstado(sena.id, 'vencido', 'sistema');
    await enviar([{ para: t.telefono, texto: `😕 Perdón, justo se ocupó el turno del ${cuando(t)}: lo tomaron un instante antes. Escribí *1* y elegimos otro horario.` }]);
  }

  async function mandarTurnos() {
    if (!esTurnos()) return 0;
    let mandados = 0;
    for (const t of qTurnos.paraNube()) {
      const estado = ESTADO_EN_NUBE[t.estado] || 'cancelado';
      const inicio = ms(t.inicio), fin = ms(t.fin);
      try {
        if (!t.nube_enviado) {
          // Uno que nunca llegó a Nodo Sur y ya no ocupa nada (cancelado antes de mandarlo, o de antes de vincular el bot) no viaja.
          if (!['esperando_sena', 'confirmado'].includes(estado) || fin < Date.now()) {
            qTurnos.marcarEnNube(t.id, { enviado: false });
            continue;
          }
          try {
            await cliente.reservarTurno({
              id: t.nube_id, inicio, fin, estado,
              cliente: { nombre: (t.clienta_nombre || '').trim() || 'Cliente de WhatsApp', telefono: t.telefono },
              servicio: { ...(t.catalogo_id ? { gid: t.catalogo_id } : {}), nombre: t.servicio },
              ...(t.sena_monto && estado === 'esperando_sena' ? { senaPedidaCentavos: t.sena_monto * 100 } : {}),
            });
            qTurnos.marcarEnNube(t.id, { enviado: true });
          } catch (e) {
            if (e.status !== 409) throw e;
            await horarioOcupado(t);
          }
        } else {
          try {
            await cliente.cambiarTurno({ id: t.nube_id, estado, inicio, fin });
            qTurnos.marcarEnNube(t.id, { enviado: true });
          } catch (e) {
            if (e.status === 404) qTurnos.marcarEnNube(t.id, { enviado: true }); // se borró allá (viejo): nada que avisar
            else if (e.status === 409) await horarioOcupado(t);
            else throw e;
          }
        }
        mandados++;
      } catch (e) {
        log.error(`No pude mandar el turno ${t.nube_id} a Nodo Sur: ${e.message}`);
        if (!e.status || e.status >= 500) break; // sin red: queda para la próxima vuelta
        qTurnos.marcarEnNube(t.id, { enviado: Boolean(t.nube_enviado) }); // un 400 no se arregla reintentando
      }
    }
    return mandados;
  }

  // Lo que hizo la dueña en la app con un turno del bot, y el mensaje para el cliente (o null si no hay que avisarle).
  function aplicarCambioDeNube(local, x) {
    const ocupaAca = OCUPA_LOCAL.includes(local.estado);
    if (x.estado === 'cancelado' && ocupaAca) {
      qTurnos.cambiarEstado(local.id, 'anulado', { desdeNube: true });
      const sena = qSenas.porTurno(local.id);
      if (sena && sena.estado === 'esperando_comprobante') qSenas.cambiarEstado(sena.id, 'vencido', 'duena');
      return { para: local.telefono, texto: `Hola ${local.clienta_nombre || ''} 👋 Tuvimos que cancelar tu turno del ${cuando(local)} (${local.servicio}). Escribí *hola* para sacar otro, ¡disculpá las molestias!` };
    }
    if (x.estado === 'atendido' || x.estado === 'no_vino') {
      if (ocupaAca) qTurnos.cambiarEstado(local.id, x.estado === 'atendido' ? 'completado' : 'no_vino', { desdeNube: true });
      return null;
    }
    let aviso = null;
    if (x.estado === 'confirmado' && local.estado === 'pendiente_sena') {
      qTurnos.cambiarEstado(local.id, 'confirmado', { desdeNube: true });
      const sena = qSenas.porTurno(local.id);
      if (sena && sena.estado !== 'verificado') qSenas.cambiarEstado(sena.id, 'verificado', 'duena');
      aviso = { para: local.telefono, texto: `¡Seña recibida! ✅ Tu turno del ${cuando(local)} quedó confirmado. ¡Te esperamos!` };
    }
    const nuevoInicio = texto(x.inicio);
    if (ocupaAca && nuevoInicio !== local.inicio) {
      qTurnos.mover(local.id, nuevoInicio, texto(x.fin), { desdeNube: true });
      aviso = { para: local.telefono, texto: `🔁 Cambiamos tu turno de ${local.servicio}: ahora es el ${cuando({ inicio: nuevoInicio })}. Si no te queda bien, escribí *hola* y lo vemos.` };
    }
    return aviso;
  }

  async function revisarTurnos() {
    if (!esTurnos()) return 0;
    let desde = (cuenta.leer() || {}).cursorTurnos || 0;
    const avisos = [];
    for (;;) {
      const r = await cliente.turnos(desde);
      for (const x of r.turnos || []) {
        if (x.origen === 'app') {
          qTurnos.guardarOcupadoNube(x.id, texto(x.inicio), texto(x.fin), x.estado);
          continue;
        }
        const local = qTurnos.porNubeId(x.id);
        // No es de este bot, o tiene un cambio propio sin mandar: gana el de acá, que sale en la próxima vuelta.
        if (!local || local.nube_pendiente) continue;
        const aviso = aplicarCambioDeNube(local, x);
        if (aviso) avisos.push(aviso);
      }
      desde = r.hasta ?? desde;
      cuenta.actualizar({ cursorTurnos: desde });
      if (!r.mas) break;
    }
    if (avisos.length) await enviar(avisos);
    return avisos.length;
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
    } else {
      try { await revisarTurnos(); } catch (e) { reportar('turnos', e); }
      try { await mandarTurnos(); } catch (e) { reportar('turnos', e); }
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

  // Lo que manda el sitio por el WebSocket: `{ bot: { config | catalogo | pedido, estado | turno | ocupados } }`. Cualquier otra cosa se ignora.
  async function alAviso(texto) {
    let m;
    try { m = JSON.parse(texto); } catch { return; }
    const a = m && m.bot;
    if (!a) return;
    try {
      if (a.config !== undefined) await traerConfig();
      if (a.catalogo) await traerCatalogo();
      if (a.pedido !== undefined && a.estado) await revisarPedidos();
      if (a.turno !== undefined || a.ocupados) await revisarTurnos();
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

  // Lo que se manda apenas pasa algo en una charla: un pedido (comercio) o un turno (servicios).
  const mandarYa = () => (esComercio() ? mandarBandeja() : mandarTurnos());

  return { traerConfig, traerCatalogo, mandarBandeja, revisarPedidos, avisarResueltos, mandarTurnos, revisarTurnos, mandarYa, ping, vuelta, alAviso, iniciar, detener };
}

module.exports = { crearSincronizador, cargarCatalogoGuardado, rutaCatalogo };
