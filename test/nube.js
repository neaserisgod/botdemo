// El bot con Nodo Sur, contra un sitio de mentira (un servidor HTTP local que contesta como horsepos.com): vincular desde
// el celular, bajar y recargar la configuración, bajar el catálogo, mandar la bandeja de pedidos una sola vez y avisarle al
// cliente cuando el local lo resuelve.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot_nube_'));
process.env.DIR_DATOS = DIR;
process.env.RUTA_DB = path.join(DIR, 'turnos.db');

const configuracion = require('../src/config');
const db = require('../src/db');
const catalogo = require('../src/core/catalogo');
const qPedidos = require('../src/db/consultas/pedidos');
const cuenta = require('../src/nube/cuenta');
const { crearCliente } = require('../src/nube/cliente');
const { crearSincronizador, cargarCatalogoGuardado } = require('../src/nube/sincronizar');
const { vincular } = require('../src/nube/vincular');
const { crearMotor } = require('../src/core/motor');

let fallas = 0;
function chequear(nombre, cond) {
  if (cond) console.log(`  ✔ ${nombre}`);
  else { console.log(`  ✘ FALLÓ: ${nombre}`); fallas++; }
}

// --- Nodo Sur de mentira -------------------------------------------------------------------------------------------------
const sitio = {
  token: 'token-del-bot', codigo: 'codigo-de-un-uso', estadoConfig: 200,
  config: { version: 0, config: null }, catalogo: { items: [], actualizado: null },
  pedidos: [], recibidos: 0, pings: 0, tokenNuevo: null,
  // El sitio de hoy (`pedidoDesdeBot`, NodoSurPage): al menos una línea y `cantidad` entera de 1 a 999; no sabe de gramos.
  aceptaGramos: false,
};
function pedidoValido(b) {
  if (!Array.isArray(b.items) || !b.items.length) return false;
  return b.items.every((x) => (sitio.aceptaGramos && Number.isInteger(x.gramos) && x.gramos > 0)
    || (Number.isInteger(x.cantidad) && x.cantidad >= 1 && x.cantidad <= 999));
}
function responder(res, status, j) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); }
const servidor = http.createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (d) => { cuerpo += d; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const b = cuerpo ? JSON.parse(cuerpo) : null;
    if (u.pathname === '/api/device/token') {
      return b.code === sitio.codigo && b.verifier.length >= 43 ? responder(res, 200, { token: sitio.token, email: 'duena@x.com' }) : responder(res, 400, { error: 'invalid_code' });
    }
    if (req.headers.authorization !== `Bearer ${sitio.token}`) return responder(res, 401, { error: 'no_device' });
    if (u.pathname === '/api/device/me') return responder(res, 200, { email: 'duena@x.com', name: 'Dueña', role: 'owner', orgId: 7, branchId: 3 });
    if (u.pathname === '/api/bot/config') return sitio.estadoConfig === 200 ? responder(res, 200, sitio.config) : responder(res, sitio.estadoConfig, { error: 'sin_plan_bot' });
    if (u.pathname === '/api/bot/catalogo') return responder(res, 200, sitio.catalogo);
    if (u.pathname === '/api/device/ping') { sitio.pings++; return responder(res, 200, { ok: true, ...(sitio.tokenNuevo ? { token: sitio.tokenNuevo } : {}) }); }
    if (u.pathname === '/api/bot/pedido' && req.method === 'POST') {
      sitio.recibidos++;
      if (!pedidoValido(b)) return responder(res, 400, { error: 'bad_request' });
      const ya = sitio.pedidos.find((p) => p.pedidoId === b.id);
      if (ya) return responder(res, 200, { ok: true, id: ya.id, repetido: true });
      const p = { id: sitio.pedidos.length + 1, pedidoId: b.id, estado: 'por_confirmar', ...b, actualizado: Date.now() };
      sitio.pedidos.push(p);
      return responder(res, 201, { ok: true, id: p.id, repetido: false });
    }
    if (u.pathname === '/api/bot/pedidos') {
      const desde = Number(u.searchParams.get('desde'));
      const lista = sitio.pedidos.filter((p) => p.actualizado > desde).sort((x, y) => x.actualizado - y.actualizado);
      return responder(res, 200, { pedidos: lista, hasta: lista.length ? lista[lista.length - 1].actualizado : desde, mas: false });
    }
    responder(res, 404, { error: 'not_found' });
  });
});

const CONFIG_ALMACEN = { negocio: { rubro: 'almacen', nombre: 'La Plazoleta', direccion: 'Mitre 150' }, textos: { quien_atiende: 'Juli' }, pausa_minutos: 30 };
const ITEMS = [
  { gid: 'g-yerba', nombre: 'Yerba Playadito 1 kg', precioCentavos: 520000, hay: true },
  { gid: 'g-jamon', nombre: 'Jamón cocido (por kg)', precioCentavos: 1500000, hay: true },
];

(async () => {
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const SITIO = `http://127.0.0.1:${servidor.address().port}`;

  console.log('\n— 1. Vincular desde el celular —');
  let abierta = null;
  // El "navegador": entra con Google, el sitio lo manda al callback del bot con el código.
  const navegador = async (url) => {
    abierta = new URL(url);
    const q = abierta.searchParams;
    setTimeout(() => http.get(`http://127.0.0.1:${q.get('port')}/callback?code=${sitio.codigo}&state=${q.get('state')}`, (r) => r.resume()), 10);
    return true;
  };
  const r = await vincular({ sitio: SITIO, abrir: navegador, alMostrar: () => {} });
  chequear('abre /vincular/ como bot, con PKCE', abierta.pathname === '/vincular/' && abierta.searchParams.get('tipo') === 'bot' && abierta.searchParams.get('challenge').length === 43);
  const c = cuenta.leer();
  chequear('guarda el token y de qué negocio y sucursal es', c.token === sitio.token && c.orgId === 7 && c.branchId === 3 && r.email === 'duena@x.com');
  chequear('el id del equipo queda fijo para la próxima vez', /^bot-[0-9a-f]{32}$/.test(c.deviceId) && require('../src/nube/vincular').idDispositivo() === c.deviceId);
  let malo = null;
  const otro = vincular({ sitio: SITIO, alMostrar: () => {}, abrir: async (url) => {
    const q = new URL(url).searchParams;
    setTimeout(() => http.get(`http://127.0.0.1:${q.get('port')}/callback?code=${sitio.codigo}&state=otro`, (rr) => { malo = rr.statusCode; rr.resume(); }), 10);
    setTimeout(() => http.get(`http://127.0.0.1:${q.get('port')}/callback?code=equivocado&state=${q.get('state')}`, (rr) => rr.resume()), 80);
    return true;
  } });
  const fallo = await otro.then(() => null, (e) => e);
  chequear('un callback de otra vinculación se rechaza, y un código equivocado no vincula', malo === 400 && fallo && /400/.test(fallo.message));

  console.log('\n— 2. Configuración desde la app —');
  const config = configuracion.armar(configuracion.ejemplo()); // arranca como el ejemplo (uñas), sin Nodo Sur
  db.abrir(process.env.RUTA_DB);
  db.sembrarServicios(config.servicios);
  const enviados = [];
  let whatsappAnda = true;
  const sinc = crearSincronizador({
    config, cliente: crearCliente({ sitio: SITIO, token: sitio.token }),
    recargarConfig: () => configuracion.recargar(config),
    enviar: async (s) => { if (!whatsappAnda) return []; enviados.push(...s); return s; },
    log: { log: () => {}, error: (m) => { sinc.errores = (sinc.errores || []).concat(m); } },
  });
  chequear('sin configuración en Nodo Sur, sigue la local', (await sinc.traerConfig()) === false && config.forma === 'turnos');
  sitio.config = { version: 1, config: CONFIG_ALMACEN };
  chequear('con configuración: la aplica', (await sinc.traerConfig()) === true);
  chequear('se recarga en el lugar, sin reiniciar: ahora es un almacén', config.forma === 'productos' && config.negocio.nombre === 'La Plazoleta' && config.textos.quien_atiende === 'Juli' && config.pausa_minutos === 30);
  chequear('la misma versión no se vuelve a aplicar', (await sinc.traerConfig()) === false);
  sitio.config = { version: 2, config: { ...CONFIG_ALMACEN, pausa_minutos: 1 } };
  chequear('una configuración que no sirve no se aplica', (await sinc.traerConfig()) === false && config.pausa_minutos === 30);
  chequear('y se vuelve a la anterior (el bot puede seguir arrancando)', configuracion.configNube().version === 1);
  chequear('el error queda en el log', (sinc.errores || []).some((m) => m.includes('pausa_minutos')));
  sitio.config = { version: 3, config: { ...CONFIG_ALMACEN, pausa_minutos: 60 } };
  await sinc.alAviso(JSON.stringify({ bot: { config: 3 } }));
  chequear('un aviso en vivo trae la configuración nueva', config.pausa_minutos === 60);

  console.log('\n— 3. Catálogo —');
  sitio.catalogo = { items: ITEMS, actualizado: 1700000000 };
  await sinc.traerCatalogo();
  chequear('lo baja y lo usa', catalogo.buscar('yerba').resultados[0]?.nombre === 'Yerba Playadito 1 kg');
  catalogo.fijar([]);
  chequear('queda guardado para arrancar sin internet', cargarCatalogoGuardado() && catalogo.cargado());

  console.log('\n— 4. Un pedido de ida y vuelta —');
  const motor = crearMotor(config);
  const CLIENTE = '5492944200001';
  for (const t of ['pedido', '2 yerba', 'listo', 'Sofi', '1']) await motor.procesarMensaje({ de: CLIENTE, texto: t });
  chequear('el pedido confirmado queda en la bandeja', qPedidos.porEnviar().length === 1);
  chequear('se manda a Nodo Sur', (await sinc.mandarBandeja()) === 1 && sitio.pedidos.length === 1);
  const enSitio = sitio.pedidos[0];
  chequear('con su id, el cliente y las líneas', /^wa-/.test(enSitio.pedidoId) && enSitio.cliente.nombre === 'Sofi' && enSitio.items[0].cantidad === 2);
  chequear('no se vuelve a mandar', (await sinc.mandarBandeja()) === 0 && sitio.recibidos === 1);
  await sinc.revisarPedidos();
  chequear('mientras está por confirmar, al cliente no se le dice nada', enviados.length === 0);

  enSitio.estado = 'aceptado'; enSitio.actualizado = Date.now() + 5;
  whatsappAnda = false;
  await sinc.revisarPedidos();
  chequear('aceptado con WhatsApp caído: queda para avisar', enviados.length === 0 && qPedidos.sinAvisar().length === 1);
  whatsappAnda = true;
  await sinc.alAviso(JSON.stringify({ bot: { pedido: enSitio.id, estado: 'aceptado' } }));
  chequear('con el aviso en vivo, el cliente se entera: pasá a retirarlo', enviados.length === 1 && enviados[0].para === CLIENTE && enviados[0].texto.includes('confirmado') && enviados[0].texto.includes('Mitre 150'));
  await sinc.revisarPedidos();
  chequear('no se le avisa dos veces', enviados.length === 1);
  chequear('el cursor de pedidos queda guardado', cuenta.leer().cursorPedidos === enSitio.actualizado);

  console.log('\n— 4b. Lo que se pesa —');
  const pedir = async (de, ...textos) => { for (const t of ['pedido', ...textos, 'listo', 'Sofi', '1']) await motor.procesarMensaje({ de, texto: t }); };
  const recibidosAntes = sitio.pedidos.length;
  await pedir('5492944200002', '1 kilo de jamon', '1 yerba');
  await sinc.mandarBandeja();
  const kilo = sitio.pedidos[recibidosAntes];
  chequear('el sitio de hoy no sabe de gramos: los kilos enteros van como cantidad (la app la toma en kilos)',
    kilo && kilo.items.some((x) => x.gid === 'g-jamon' && x.cantidad === 1 && x.gramos === undefined));
  enviados.length = 0;
  await pedir('5492944200003', '1/4 de jamon', '2 yerba');
  await sinc.mandarBandeja();
  chequear('250 g no entra en el sitio de hoy: no se manda a medias', sitio.pedidos.length === recibidosAntes + 1);
  chequear('le llega entero al local por WhatsApp, para prepararlo a mano', enviados.length === 1 && enviados[0].para === config.numero_duena
    && enviados[0].texto.includes('250 g de Jamón cocido') && enviados[0].texto.includes('2 × Yerba') && enviados[0].texto.includes('5492944200003'));
  chequear('y no queda trabado en la bandeja', qPedidos.porEnviar().length === 0);
  sitio.aceptaGramos = true;
  const sincNuevo = crearSincronizador({ config, cliente: crearCliente({ sitio: SITIO, token: sitio.token }), recargarConfig: () => [],
    enviar: async (x) => { enviados.push(...x); return x; }, log: { log: () => {}, error: () => {} } });
  await pedir('5492944200004', '1/4 de jamon');
  await sincNuevo.mandarBandeja();
  const gramos = sitio.pedidos[sitio.pedidos.length - 1];
  chequear('con un sitio que acepta gramos: va en gramos, con el precio por kilo', gramos.items.length === 1
    && gramos.items[0].gramos === 250 && gramos.items[0].precioCentavos === 1500000 && gramos.items[0].cantidad === undefined);

  console.log('\n— 5. Ping, token y lo que sale mal —');
  sitio.tokenNuevo = 'token-renovado';
  await sinc.ping();
  chequear('el ping avisa que está vivo y guarda el token renovado', sitio.pings === 1 && cuenta.leer().token === 'token-renovado');
  sitio.token = 'otro'; // el sitio ya no reconoce al bot (lo desvincularon)
  sinc.errores = [];
  await sinc.vuelta(); await sinc.vuelta();
  chequear('desvinculado: lo dice una sola vez, con cómo arreglarlo', sinc.errores.filter((m) => m.includes('vincular-nodosur')).length === 1);
  sitio.token = 'token-renovado'; sitio.estadoConfig = 403;
  const sinPlan = crearSincronizador({ config, cliente: crearCliente({ sitio: SITIO, token: 'token-renovado' }), recargarConfig: () => [], enviar: async () => [],
    log: { log: () => {}, error: (m) => { sinPlan.errores = (sinPlan.errores || []).concat(m); } } });
  await sinPlan.vuelta();
  chequear('sin plan con bot: lo dice, y sigue andando con lo que tiene', (sinPlan.errores || []).some((m) => m.includes('plan con bot')) && config.forma === 'productos');

  servidor.close();
  console.log(fallas ? `\n❌ ${fallas} chequeos de Nodo Sur fallaron` : '\n✅ Nodo Sur OK');
  process.exit(fallas ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
