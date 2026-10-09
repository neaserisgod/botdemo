// Cliente del sitio de Nodo Sur (horsepos.com) para el bot: lo que el sitio le da (`/api/bot/*`, ver el README de
// NodoSurPage) y el ping que dice que está vivo. Todo con el token del equipo y con plazo: un corte nunca cuelga al bot.
const PLAZO_MS = 20000;

class ErrorNube extends Error {
  constructor(status, codigo) {
    super(`Nodo Sur contestó ${status}${codigo ? ` (${codigo})` : ''}`);
    this.status = status;
    this.codigo = codigo;
  }
  // El equipo ya no vale (lo desvincularon o quien lo vinculó dejó el negocio): hay que volver a vincularlo.
  get desvinculado() { return this.status === 401; }
  // El negocio no tiene un plan con bot.
  get sinPlan() { return this.codigo === 'sin_plan_bot'; }
}

function crearCliente({ sitio, token, fetch = globalThis.fetch }) {
  async function pedir(ruta, { metodo = 'GET', cuerpo } = {}) {
    const r = await fetch(`${sitio}${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${token}`, ...(cuerpo ? { 'Content-Type': 'application/json' } : {}) },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: AbortSignal.timeout(PLAZO_MS),
    });
    let j = null;
    try { j = await r.json(); } catch { /* sin cuerpo */ }
    if (!r.ok) throw new ErrorNube(r.status, j && j.error);
    return j;
  }
  return {
    yo: () => pedir('/api/device/me'),
    config: () => pedir('/api/bot/config'),
    catalogo: () => pedir('/api/bot/catalogo'),
    mandarPedido: (p) => pedir('/api/bot/pedido', { metodo: 'POST', cuerpo: p }),
    pedidos: (desde) => pedir(`/api/bot/pedidos?desde=${encodeURIComponent(desde)}`),
    ping: (version) => pedir('/api/device/ping', { metodo: 'POST', cuerpo: { version, os: 'Android (Termux)' } }),
    urlEscucha: () => `${sitio.replace(/^http/, 'ws')}/api/sync/escuchar`,
    token,
  };
}

module.exports = { crearCliente, ErrorNube };
