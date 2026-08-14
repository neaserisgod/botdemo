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
function buscar(config, texto, listaServicios) {
  const contiene = (claves) => claves.some((k) => texto.includes(k));
  if (contiene(config.faq.precios)) return precios(listaServicios);
  if (contiene(config.faq.ubicacion) || contiene(config.faq.horarios)) {
    return ubicacionYHorarios(config);
  }
  return null;
}

module.exports = { buscar, precios, ubicacionYHorarios };
