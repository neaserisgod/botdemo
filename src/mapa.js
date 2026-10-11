// El pin del local en el mapa (El dueño, 2026-10-11): con "ubicación" el bot manda, además de la dirección escrita, la
// ubicación de WhatsApp, que se abre en el mapa del celular. Las coordenadas salen del link de Google Maps que carga el
// negocio (`negocio.ubicacion_maps`). El link que da el botón "Compartir" de Maps es corto (maps.app.goo.gl/…) y no las trae:
// se sigue la redirección una vez, al arrancar o cuando cambia el link, y quedan en `negocio.coordenadas` (solo en memoria).

// Las formas en que un link de Maps (o un texto) trae las coordenadas, de la más precisa a la menos.
const FORMAS = [
  /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/, // el punto marcado
  /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/, // el centro del mapa
  /[?&](?:q|query|ll|destination|center)=(-?\d{1,2}\.\d+)(?:,|%2C)\s*(-?\d{1,3}\.\d+)/i,
  /^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/, // "-41.1335, -71.3103" pegado a mano
];

/** { lat, lng } del texto, o null. */
function coordenadasDeTexto(texto) {
  if (typeof texto !== 'string') return null;
  let t = texto;
  try { t = decodeURIComponent(texto); } catch { /* queda como vino */ }
  for (const forma of FORMAS) {
    const m = t.match(forma);
    if (!m) continue;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)) return { lat, lng };
  }
  return null;
}

const esLinkCorto = (url) => /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\//i.test(url || '');

/**
 * Completa `config.negocio.coordenadas` a partir de `config.negocio.ubicacion_maps`. Nunca tira: sin red o con un link que no
 * se entiende, queda sin pin y el bot manda la dirección escrita como siempre.
 */
// Link → coordenadas ya resueltas: recargar la configuración (`config.recargar`) la arma de cero y no hace falta volver a
// salir a internet por el mismo link.
const resueltos = new Map();

async function resolverCoordenadas(config, { buscar = globalThis.fetch } = {}) {
  const negocio = config.negocio || {};
  const link = (negocio.ubicacion_maps || '').trim();
  let coordenadas = resueltos.has(link) ? resueltos.get(link) : coordenadasDeTexto(link);
  if (!coordenadas && esLinkCorto(link) && buscar) {
    try {
      const r = await buscar(link, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
      coordenadas = coordenadasDeTexto(r.url);
      if (!coordenadas) coordenadas = coordenadasDeTexto(((await r.text()) || '').slice(0, 200000).match(/@-?\d{1,2}\.\d+,-?\d{1,3}\.\d+/)?.[0] || '');
    } catch (e) {
      console.error('No pude leer el link de Google Maps:', e.message);
      return null; // se reintenta en la próxima carga
    }
  }
  resueltos.set(link, coordenadas);
  if (coordenadas) negocio.coordenadas = coordenadas;
  else delete negocio.coordenadas;
  return coordenadas;
}

module.exports = { coordenadasDeTexto, resolverCoordenadas };
