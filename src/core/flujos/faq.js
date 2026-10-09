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
  return `📍 *${config.negocio.nombre}*\n${config.negocio.direccion}\n${config.negocio.ubicacion_maps}\n\n🕐 *Horarios:*\n${horarios}`;
}

module.exports = { precios, ubicacionYHorarios };
