// Turnos con Nodo Sur (negocios de servicios vinculados, 2026-10-10), contra un sitio de mentira que reserva como
// horsepos.com (`functions/_lib/bot_turnos.js`): el turno se reserva una sola vez, si otro tomó el horario el cliente
// elige otro, el bot no ofrece lo que ocupa la agenda de la app, y si la dueña mueve, cancela o anota la seña en la app,
// el cliente se entera.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot_turnos_nube_'));
process.env.DIR_DATOS = DIR;
process.env.RUTA_DB = path.join(DIR, 'turnos.db');

const configuracion = require('../src/config');
const db = require('../src/db');
const qTurnos = require('../src/db/consultas/turnos');
const qClientas = require('../src/db/consultas/clientas');
const qSenas = require('../src/db/consultas/senas');
const agenda = require('../src/core/agenda');
const fechas = require('../src/core/fechas');
const { crearCliente } = require('../src/nube/cliente');
const { crearSincronizador } = require('../src/nube/sincronizar');
const cuenta = require('../src/nube/cuenta');

let fallas = 0;
function chequear(nombre, cond) {
  if (cond) console.log(`  ✔ ${nombre}`);
  else { console.log(`  ✘ FALLÓ: ${nombre}`); fallas++; }
}

// --- Nodo Sur de mentira: reserva como el de verdad -----------------------------------------------------------------------
const OCUPAN = ['esperando_sena', 'confirmado', 'atendido'];
const sitio = { token: 'tk', turnos: [], reservas: 0, cambios: [], reloj: 1000 };
const pisa = (a, b) => a.inicio < b.fin && b.inicio < a.fin;
function responder(res, status, j) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); }
const servidor = http.createServer((req, res) => {
  let cuerpo = '';
  req.on('data', (d) => { cuerpo += d; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const b = cuerpo ? JSON.parse(cuerpo) : null;
    if (req.headers.authorization !== `Bearer ${sitio.token}`) return responder(res, 401, { error: 'no_device' });
    if (u.pathname === '/api/bot/turno' && req.method === 'POST') {
      sitio.reservas++;
      if (sitio.turnos.some((t) => t.id === b.id)) return responder(res, 200, { ok: true, id: b.id, repetido: true });
      if (sitio.turnos.some((t) => OCUPAN.includes(t.estado) && pisa(t, b))) return responder(res, 409, { error: 'ocupado' });
      sitio.turnos.push({ ...b, origen: 'bot', actualizado: ++sitio.reloj });
      return responder(res, 201, { ok: true, id: b.id, repetido: false });
    }
    if (u.pathname === '/api/bot/turno/cambio' && req.method === 'POST') {
      const t = sitio.turnos.find((x) => x.id === b.id);
      if (!t) return responder(res, 404, { error: 'no_existe' });
      sitio.cambios.push(b);
      Object.assign(t, b, { actualizado: ++sitio.reloj });
      return responder(res, 200, { ok: true });
    }
    if (u.pathname === '/api/bot/turnos') {
      const desde = Number(u.searchParams.get('desde'));
      const lista = sitio.turnos.filter((t) => t.actualizado > desde).sort((x, y) => x.actualizado - y.actualizado);
      return responder(res, 200, { turnos: lista, hasta: lista.length ? lista[lista.length - 1].actualizado : desde, mas: false });
    }
    responder(res, 404, { error: 'not_found' });
  });
});

(async () => {
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const SITIO = `http://127.0.0.1:${servidor.address().port}`;
  cuenta.guardar({ sitio: SITIO, token: sitio.token, email: 'caro@x.com', orgId: 1, branchId: 1, deviceId: 'bot-x' });

  const config = configuracion.armar(configuracion.ejemplo()); // uñas: turnos con seña
  db.abrir(process.env.RUTA_DB);
  db.sembrarServicios(config.servicios);
  const enviados = [];
  const sinc = crearSincronizador({
    config, cliente: crearCliente({ sitio: SITIO, token: sitio.token }),
    recargarConfig: () => configuracion.recargar(config),
    enviar: async (s) => { enviados.push(...s); return s; },
    log: { log: () => {}, error: () => {} },
  });

  // Un día abierto dentro de una semana, a las 10.
  let dia = null;
  for (let i = 2; i < 10 && !dia; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const ymd = fechas.aTexto(d).slice(0, 10);
    if (config.horarios[fechas.nombreDia(ymd)]) dia = ymd;
  }
  const a = (hhmm) => `${dia} ${hhmm}`;
  const ms = (texto) => fechas.deTexto(texto).getTime();
  const semi = config.servicios.find((s) => s.sena > 0);
  const sinSena = config.servicios.find((s) => !s.sena);
  const clienta = (tel, nombre) => { const c = qClientas.obtenerOCrear(tel); qClientas.guardarNombre(c.id, nombre); return c.id; };

  console.log('\n— 1. Reservar en Nodo Sur —');
  const ana = clienta('5492944300001', 'Ana');
  const idAna = qTurnos.crear(ana, semi.id, a('10:00'), fechas.sumarMinutos(a('10:00'), semi.duracion_min), 'pendiente_sena');
  qSenas.crear(idAna, semi.sena, a('09:00'));
  chequear('se manda apenas se da', (await sinc.mandarTurnos()) === 1 && sitio.turnos.length === 1);
  const enSitio = sitio.turnos[0];
  chequear('con su horario, el cliente, el servicio y la seña pedida en centavos', enSitio.estado === 'esperando_sena'
    && enSitio.inicio === ms(a('10:00')) && enSitio.cliente.nombre === 'Ana' && enSitio.cliente.telefono === '5492944300001'
    && enSitio.servicio.nombre === semi.nombre && enSitio.senaPedidaCentavos === semi.sena * 100);
  chequear('no se vuelve a mandar', (await sinc.mandarTurnos()) === 0 && sitio.reservas === 1);

  console.log('\n— 2. Otro tomó el horario un instante antes —');
  sitio.turnos.push({ id: 'turno-otro-bot-01', origen: 'bot', estado: 'confirmado', inicio: ms(a('15:00')), fin: ms(a('16:00')), actualizado: ++sitio.reloj });
  const bea = clienta('5492944300002', 'Bea');
  const idBea = qTurnos.crear(bea, sinSena.id, a('15:00'), fechas.sumarMinutos(a('15:00'), sinSena.duracion_min), 'confirmado');
  enviados.length = 0;
  await sinc.mandarTurnos();
  chequear('el turno queda sin valer y el horario libre acá', qTurnos.porId(idBea).estado === 'ocupado');
  chequear('al cliente se le pide que elija otro', enviados.length === 1 && enviados[0].para === '5492944300002' && /se ocupó/.test(enviados[0].texto) && /\*1\*/.test(enviados[0].texto));
  chequear('y no se reintenta', (await sinc.mandarTurnos()) === 0);

  console.log('\n— 3. Lo que ocupa la agenda de la app —');
  sitio.turnos.push({ id: 'gid-app-000000001', origen: 'app', estado: 'confirmado', profesional: '', inicio: ms(a('12:00')), fin: ms(a('13:00')), actualizado: ++sitio.reloj });
  await sinc.revisarTurnos();
  const libres = agenda.horariosLibres(config, sinSena, dia);
  chequear('el bot no ofrece lo que dio la dueña en la app', !libres.includes('12:00') && !libres.some((h) => h > '11:30' && h < '13:00'));
  chequear('sí lo de al lado', libres.includes('13:00'));
  sitio.turnos.find((t) => t.id === 'gid-app-000000001').estado = 'cancelado';
  sitio.turnos.find((t) => t.id === 'gid-app-000000001').actualizado = ++sitio.reloj;
  await sinc.alAviso(JSON.stringify({ bot: { ocupados: true } }));
  chequear('si la dueña lo cancela, el horario vuelve a estar', agenda.horariosLibres(config, sinSena, dia).includes('12:00'));

  console.log('\n— 4. La dueña en la app —');
  enviados.length = 0;
  enSitio.estado = 'confirmado'; enSitio.actualizado = ++sitio.reloj;
  await sinc.revisarTurnos();
  chequear('anotó la seña: el turno queda confirmado y el cliente se entera', qTurnos.porId(idAna).estado === 'confirmado'
    && qSenas.porTurno(idAna).estado === 'verificado' && enviados.length === 1 && /confirmado/.test(enviados[0].texto));
  chequear('y ese cambio no vuelve a Nodo Sur (no es un cambio de acá)', (await sinc.mandarTurnos()) === 0);

  enviados.length = 0;
  Object.assign(enSitio, { inicio: ms(a('17:00')), fin: ms(a('18:00')), actualizado: ++sitio.reloj });
  await sinc.alAviso(JSON.stringify({ bot: { turno: enSitio.id } }));
  chequear('lo movió: el turno cambia de hora y el cliente se entera', qTurnos.porId(idAna).inicio === a('17:00') && enviados.length === 1 && /17:00/.test(enviados[0].texto));

  enviados.length = 0;
  Object.assign(enSitio, { estado: 'cancelado', actualizado: ++sitio.reloj });
  await sinc.revisarTurnos();
  chequear('lo canceló: libera el horario y le avisa', qTurnos.porId(idAna).estado === 'anulado' && enviados.length === 1 && /cancelar/.test(enviados[0].texto));
  chequear('el cursor queda guardado', cuenta.leer().cursorTurnos === sitio.reloj);

  console.log('\n— 5. Lo que cambia acá llega a Nodo Sur —');
  const caro = clienta('5492944300003', 'Caro');
  const idCaro = qTurnos.crear(caro, sinSena.id, a('11:00'), fechas.sumarMinutos(a('11:00'), sinSena.duracion_min), 'confirmado');
  await sinc.mandarTurnos();
  qTurnos.cambiarEstado(idCaro, 'cancelado'); // la clienta cancela por WhatsApp
  await sinc.mandarTurnos();
  const remoto = qTurnos.porId(idCaro).nube_id;
  chequear('la clienta canceló: Nodo Sur lo sabe', sitio.cambios.some((c) => c.id === remoto && c.estado === 'cancelado'));
  const viejo = qTurnos.crear(caro, sinSena.id, a('19:00'), a('19:30'), 'cancelado');
  chequear('uno cancelado antes de mandarlo no viaja', (await sinc.mandarTurnos()) === 0 && !sitio.turnos.some((t) => t.id === qTurnos.porId(viejo).nube_id));

  servidor.close();
  console.log(fallas ? `\n❌ ${fallas} chequeos de turnos con Nodo Sur fallaron` : '\n✅ Turnos con Nodo Sur OK');
  process.exit(fallas ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
