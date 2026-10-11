// Las respuestas de precios y de ubicación y horarios. Cuándo se dan lo decide el diccionario (nlu.tema, diccionario/comun.js).
const NOMBRES_DIA = {
  lunes: 'Lunes', martes: 'Martes', miercoles: 'Miércoles',
  jueves: 'Jueves', viernes: 'Viernes', sabado: 'Sábado', domingo: 'Domingo',
};

function precios(lista) {
  return `💰 *Precios:*\n\n${lista}\n\nPara reservar, escribí *1* 😊`;
}

function ubicacionYHorarios(config) {
  const horarios = Object.entries(config.horarios)
    .map(([dia, h]) => `${NOMBRES_DIA[dia]}: ${h ? `${h.desde} a ${h.hasta}` : 'cerrado'}`)
    .join('\n');
  // Sin dirección o sin link cargados no queda un renglón vacío.
  const lugar = [config.negocio.direccion, config.negocio.ubicacion_maps].filter((x) => x && String(x).trim()).join('\n');
  return `📍 *${config.negocio.nombre}*${lugar ? `\n${lugar}` : ''}\n\n🕐 *Horarios:*\n${horarios}`;
}

// La respuesta de ubicación lleva el pin del local si se conocen sus coordenadas (`src/mapa.js`): el adaptador de Baileys lo
// manda como ubicación de WhatsApp después del texto; los demás lo ignoran.
function conPin(salientes, config) {
  const c = config.negocio?.coordenadas;
  if (c && salientes?.[0]) {
    salientes[0].ubicacion = { lat: c.lat, lng: c.lng, nombre: config.negocio.nombre, direccion: config.negocio.direccion || '' };
  }
  return salientes;
}

module.exports = { precios, ubicacionYHorarios, conPin };
