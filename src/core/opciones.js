// Los menús numerados del bot ("*1* — Reservar un turno") como encuesta de WhatsApp: la clienta toca la opción en vez de
// escribir el número (El dueño, 2026-10-11). El núcleo sigue escribiendo el menú como texto, que es lo que ven los
// adaptadores sin encuestas (consola, whatsapp-web.js) y lo que se manda si la encuesta falla. El adaptador de Baileys lo
// parte con esta función y el voto vuelve como si la clienta hubiera escrito el número: los estados no se enteran.
//
// Sin dependencias: se prueba en test/opciones.js.

// WhatsApp acepta hasta 12 opciones por encuesta, de hasta 100 letras cada una, y una pregunta de hasta 255.
const MAX_OPCIONES = 12;
const MAX_LARGO_OPCION = 100;
const MAX_LARGO_PREGUNTA = 255;

const LINEA_OPCION = /^\*(\d+)\* — (.+)$/;

// Las encuestas no muestran negrita: "*Corte*" se vería con asteriscos.
const sinFormato = (t) => t.replace(/[*_~]/g, '').trim();

function recortar(t, max) {
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

// La línea "Respondé con el número…" ya no dice lo que hay que hacer: se toca la encuesta. Lo que agregaba ("*0* para
// volver", "*menú* para empezar de nuevo") se conserva, porque eso se sigue escribiendo.
function pieParaEncuesta(linea) {
  const m = linea.match(/^\(?Respondé con el número[,.]?\s*(.*?)\)?\.?$/i);
  if (!m) return linea;
  let resto = m[1].replace(/^\(|\)$/g, '').trim();
  if (!resto) return '';
  resto = resto.replace(/^(o|y)\s+/i, '');
  return `Si no, escribí ${resto}.`;
}

/**
 * Parte un mensaje con un menú numerado. Devuelve null si no tiene uno que sirva como encuesta (menos de 2 opciones, más
 * de 12, números repetidos, o opciones iguales).
 *
 * @returns {{ texto: string, pregunta: string, opciones: { numero: number, texto: string }[] } | null}
 *   texto: lo que va antes de la encuesta (vacío si no queda nada); pregunta: el título de la encuesta.
 */
function separarOpciones(mensaje) {
  if (typeof mensaje !== 'string' || !mensaje.includes('—')) return null;
  const lineas = mensaje.split('\n');
  // El primer bloque de líneas seguidas con forma de opción.
  let desde = -1;
  let hasta = -1;
  for (let i = 0; i < lineas.length; i++) {
    if (LINEA_OPCION.test(lineas[i].trim())) {
      if (desde < 0) desde = i;
      hasta = i;
    } else if (desde >= 0) {
      break;
    }
  }
  if (desde < 0) return null;
  const opciones = lineas.slice(desde, hasta + 1).map((l) => {
    const [, n, t] = l.trim().match(LINEA_OPCION);
    return { numero: Number(n), texto: recortar(sinFormato(t), MAX_LARGO_OPCION) };
  });
  if (opciones.length < 2 || opciones.length > MAX_OPCIONES) return null;
  if (new Set(opciones.map((o) => o.numero)).size !== opciones.length) return null;
  // El voto se reconoce por el texto de la opción: dos iguales no se podrían distinguir.
  if (new Set(opciones.map((o) => o.texto)).size !== opciones.length) return null;

  const antes = lineas.slice(0, desde);
  while (antes.length && !antes[antes.length - 1].trim()) antes.pop();
  // La pregunta de la encuesta es la última línea de antes si pregunta algo ("¿Qué día te queda bien?"); si no, una
  // genérica, y el texto de antes va entero como mensaje.
  let pregunta = 'Elegí una opción';
  const ultima = antes.length ? antes[antes.length - 1].trim() : '';
  if (/[?:]$/.test(ultima) && !/^[📅💰🔁💸]/u.test(ultima)) {
    pregunta = recortar(sinFormato(ultima), MAX_LARGO_PREGUNTA);
    antes.pop();
    while (antes.length && !antes[antes.length - 1].trim()) antes.pop();
  }

  const despues = lineas.slice(hasta + 1).map((l) => pieParaEncuesta(l.trim())).filter((l) => l);
  const partes = [antes.join('\n').trim(), despues.join('\n').trim()].filter((p) => p);
  return { texto: partes.join('\n\n'), pregunta, opciones };
}

module.exports = { separarOpciones, MAX_OPCIONES };
