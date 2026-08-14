// FAQ por palabras clave (precios, ubicación, horarios), configurable por cliente.
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

// Devuelve la respuesta si el texto matchea alguna palabra clave, o null.
// Usa el matcher del NLU: normaliza tildes y tolera typos ("presios" → precios).
const nlu = require('../nlu');

function buscar(config, texto, listaServicios) {
  const textoNorm = nlu.normalizar(texto);
  const tokens = textoNorm.split(' ');
  const hay = (claves) => claves.some((k) => nlu.contiene(textoNorm, tokens, nlu.normalizar(k)));
  if (hay(config.faq.precios)) return precios(listaServicios);
  if (hay(config.faq.ubicacion) || hay(config.faq.horarios)) {
    return ubicacionYHorarios(config);
  }
  return null;
}

module.exports = { buscar, precios, ubicacionYHorarios };
