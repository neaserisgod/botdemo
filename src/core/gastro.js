// Lo de un local gastronómico (rotisería, take away) que el bot necesita para tomar un pedido: cómo se entrega, cuánto sale
// el envío, cuándo sale y cómo se paga. Lo manda la app de Nodo Gastro en `config.pedidos` (`configBotConPedidos`,
// Nodo-Sur-Pos/lib/domain/bot_whatsapp.dart); sin eso el bot es el de un almacén (retiro y nada más).
//
// La hora es la misma regla que la app (`cuandoSale`, Nodo-Sur-Pos/lib/domain/pedido_gastronomico.dart, REGLAS-NEGOCIO §22):
// las dos tienen que dar lo mismo, porque la app muestra la hora que el bot le dijo al cliente. Si una cambia, la otra también.
const fechas = require('./fechas');

const esGastro = (config) => !!(config.pedidos && typeof config.pedidos === 'object');

const FORMAS = {
  RETIRO: { clave: 'RETIRO', texto: 'Paso a retirarlo', envio: false },
  CADETE: { clave: 'CADETE', texto: 'Que me lo traigan', envio: true },
  REPARTO: { clave: 'REPARTO', texto: 'Que me lo traigan', envio: true },
};

// Las formas prendidas, en el orden en que se ofrecen. El cadete propio y el servicio de reparto son lo mismo para el
// cliente (se lo llevan): si están los dos se ofrece uno solo, el cadete propio. Ninguna prendida es retiro.
function formas(config) {
  const p = config.pedidos || {};
  const lista = [];
  if (p.retiro !== false) lista.push(FORMAS.RETIRO);
  if (p.cadete) lista.push(FORMAS.CADETE);
  else if (p.reparto) lista.push(FORMAS.REPARTO);
  return lista.length ? lista : [FORMAS.RETIRO];
}

const zonas = (config) => (config.pedidos?.zonas || []).filter((z) => z && typeof z.nombre === 'string' && z.nombre.trim());

// Lo que cuesta llevarlo a esa zona, en centavos (la app manda pesos enteros).
const costoEnvio = (forma, zona) => (forma.envio && zona ? Math.max(0, Math.round(Number(zona.costo) || 0)) * 100 : 0);

const pausada = (config) => config.pedidos?.cocina === 'pausada';

function minutosDePreparacion(config) {
  const p = config.pedidos || {};
  if (p.cocina === 'pausada') return null;
  return p.cocina === 'demorada' ? (p.minutos_demorada ?? 60) : (p.minutos_normal ?? 30);
}

function horaEstimada(config, desde, forma, zona) {
  const min = minutosDePreparacion(config);
  if (min == null) return null;
  const extra = forma.envio ? (Number(zona?.demora_min) || 0) : 0;
  return new Date(desde.getTime() + (min + extra) * 60000);
}

const aMinutos = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// Cuándo sale: dentro del horario, la hora de siempre; fuera de hora, desde que abre (queda programado). Null con la cocina
// pausada. Un horario sin días abiertos se toma como siempre abierto.
function cuandoSale(config, forma, zona, ahora = fechas.ahora()) {
  const sale = (desde) => horaEstimada(config, desde, forma, zona);
  const horarios = config.horarios || {};
  if (!Object.values(horarios).some(Boolean)) {
    const h = sale(ahora);
    return h && { hora: h, programado: false };
  }
  for (let d = 0; d < 8; d++) {
    const dia = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() + d);
    const franja = horarios[fechas.DIAS[dia.getDay()]];
    if (!franja || !franja.desde || !franja.hasta) continue;
    const abre = new Date(dia.getTime() + aMinutos(franja.desde) * 60000);
    const cierra = new Date(dia.getTime() + aMinutos(franja.hasta) * 60000);
    if (d === 0 && ahora >= abre && ahora < cierra) {
      const h = sale(ahora);
      return h && { hora: h, programado: false };
    }
    if (abre > ahora) {
      const h = sale(abre);
      return h && { hora: h, programado: true };
    }
  }
  return null;
}

// "a las 21:30", "mañana a las 20:30", "el Sábado 18/10 a las 20:30".
function textoHora(hora, ahora = fechas.ahora()) {
  const t = fechas.aTexto(hora);
  const hoy = fechas.aTexto(ahora).slice(0, 10);
  const manana = fechas.aTexto(new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() + 1)).slice(0, 10);
  const ymd = t.slice(0, 10);
  const dia = ymd === hoy ? '' : ymd === manana ? 'mañana ' : `el ${fechas.diaLindo(ymd)} `;
  return `${dia}a las ${t.slice(11)}`;
}

// Cómo puede pagar: al recibir, o adelantado por Mercado Pago (link) o transferencia al alias (El dueño, 2026-10-16: "ambas").
// Mercado Pago solo si el negocio lo conectó (el sitio lo dice en `pedidos.mp`); el alias, si está cargado. Si para pagar
// adelantado no hay ninguno de los dos, se paga al recibir.
function pagos(config) {
  const p = config.pedidos || {};
  const adelantado = [...(p.mp === true ? ['mp'] : []), ...(typeof p.alias === 'string' && p.alias.trim() ? ['alias'] : [])];
  if (!adelantado.length || !['adelantado', 'a_elegir'].includes(p.pago)) return ['al_entregar'];
  return p.pago === 'adelantado' ? adelantado : ['al_entregar', ...adelantado];
}

const TEXTO_PAGO = { al_entregar: 'Pago al recibir', mp: 'Pago ahora con Mercado Pago', alias: 'Transfiero ahora' };

function textoAlias(config, total) {
  const p = config.pedidos || {};
  const titular = p.titular ? ` (a nombre de *${p.titular}*)` : '';
  return `Transferí *${total}* al alias *${p.alias}*${titular} y mandame el comprobante por acá 🙏`;
}

// El link del catálogo de WhatsApp Business del local, si lo tiene (se prende en config.json: `negocio.catalogo_whatsapp`).
const linkCatalogo = (config) => (config.negocio?.catalogo_whatsapp ? `https://wa.me/c/${config.numero_actual}` : null);

module.exports = {
  esGastro, formas, zonas, costoEnvio, pausada, cuandoSale, textoHora, pagos, TEXTO_PAGO, textoAlias, linkCatalogo, FORMAS,
};
