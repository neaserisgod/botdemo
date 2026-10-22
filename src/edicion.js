// Lo que cambia en esta edición del bot. Esta rama (claude/personalized-burger-bot-in0fgb) es la beta de Nodo Gastro para la
// hamburguesería del dueño (2026-10-22): va adentro de la app solo en una beta (publicar-apk a mano, `bot_ref` = esta rama), y la
// versión estable sigue con el bot de main. Por eso es una excepción y no una opción: Nodo Gastro tiene un solo rubro para toda la
// gastronomía (Nodo-Sur-Pos, decisión del 18/10), y acá ese rubro se atiende como hamburguesería.
//
// Con BOT_EDICION=base se comporta como main: así corren los tests de siempre (`npm test`), y la edición se prueba aparte
// (test/hamburgueseria.js).
const base = () => process.env.BOT_EDICION === 'base';

module.exports = {
  // El rubro de gastronomía que manda Nodo Gastro (`rotiseria`) se atiende con la plantilla de hamburguesería, con la IA prendida
  // para lo que no entiende (usa la clave de Gemini del negocio, por Nodo Sur; ver src/ia.js).
  gastronomiaComo: () => (base() ? null : 'hamburgueseria'),
};
