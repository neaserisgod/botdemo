// La IA para lo que el bot no entiende (solo comercios). No le contesta al cliente: reescribe su mensaje como una frase
// simple que las reglas del bot sí entienden ("mandame la de huevo frito sin pepino y algo cola" → "1 Burger Egg sin pepino\n
// 1 Coca Cola 500 ml"), y el bot sigue como siempre: los precios, el stock y lo que se anota salen del catálogo, nunca de la IA.
// Si la IA no está segura, no hay clave, se pasó del máximo del día o tarda, el bot sigue como sin IA (le avisa a una persona).
//
// Gemini, de dos formas:
//  * con el bot vinculado a Nodo Sur, la clave del negocio que el dueño cargó en la app (Configuración › Asistente IA): el bot le
//    pide a Nodo Sur (`/api/bot/ia`) y la clave nunca pasa por el celular;
//  * o una clave propia (la gratuita de aistudio.google.com › Get API key) en config.json, que va directo a Google:
//      "ia": { "habilitada": true, "clave_gemini": "AIza…" }   (o la variable GEMINI_API_KEY)
// Opcionales: "modelo" (por defecto gemini-3.5-flash-lite) y "maximo_por_dia" (por defecto 200, para no pasarse del plan gratis).
const MODELO = 'gemini-3.5-flash-lite';
const ESPERA_MS = 8000;

const clave = (config) => config.ia?.clave_gemini || process.env.GEMINI_API_KEY || '';
// `nube`: con el bot vinculado, `(modelo, cuerpo) => respuesta de Google` por Nodo Sur (`cliente.ia`).
const disponible = (config, nube) => !!(config.ia?.habilitada && (clave(config) || nube));

let dia = '';
let usadas = 0;
function quedanHoy(config) {
  const hoy = new Date().toISOString().slice(0, 10);
  if (hoy !== dia) { dia = hoy; usadas = 0; }
  return usadas < (Number(config.ia?.maximo_por_dia) || 200);
}

const INSTRUCCIONES = `Sos el traductor de un bot de WhatsApp que toma pedidos para un local. El bot solo entiende frases simples; vos \
reescribís el último mensaje del cliente para que el bot lo entienda. No le contestás al cliente.

Reglas:
- Para pedir: un renglón por producto, "cantidad nombre", con el nombre EXACTO de la carta (sin el precio). Si hay una aclaración para la cocina, \
va después del nombre: "1 Hamburguesa Clásica sin cebolla".
- Si el paso tiene opciones numeradas y el mensaje elige una, devolvé solo el número. Para no elegir ninguna, "0".
- Si el paso pide un dato (dirección, nombre), devolvé solo ese dato.
- Si pide sacar algo del pedido: "sacame la <nombre>". Si quiere cancelar todo: "cancelar". Si terminó de pedir: "listo".
- Si pregunta algo, reescribilo como una pregunta corta: "¿hacen envíos?", "¿cuánto sale la <nombre>?", "¿a qué hora abren?", \
"¿cómo se paga?", "¿cuánto tarda?". Si quiere hablar con una persona: "hablar con una persona".
- Nunca inventes productos que no están en la carta, ni precios.
- Si no estás seguro de qué quiere, o pide algo que la carta no tiene, respondé entendido: false.`;

// Lo que pasa el bot (`comercio.js`, pedirIA): { mensaje, paso, opciones, pedido, carta, negocio }.
async function reescribir(config, contexto, { nube } = {}) {
  if (!disponible(config, nube) || !quedanHoy(config)) return null;
  usadas++;
  const modelo = config.ia.modelo || MODELO;
  const cuerpo = {
    systemInstruction: { parts: [{ text: INSTRUCCIONES }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(contexto) }] }],
    generationConfig: {
      temperature: 0,
      // Que conteste rápido: el cliente está esperando en WhatsApp.
      thinkingConfig: { thinkingLevel: 'minimal' },
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: { entendido: { type: 'BOOLEAN' }, texto: { type: 'STRING' } },
        required: ['entendido', 'texto'],
      },
    },
  };
  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(), ESPERA_MS);
  try {
    let datos;
    if (clave(config)) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': clave(config) },
        body: JSON.stringify(cuerpo),
        signal: corte.signal,
      });
      if (!r.ok) {
        console.error(`IA: Gemini contestó ${r.status} ${(await r.text()).slice(0, 200)}`);
        return null;
      }
      datos = await r.json();
    } else {
      // Por Nodo Sur, con la clave del negocio. Se espera lo mismo que directo.
      datos = await Promise.race([
        nube(modelo, JSON.stringify(cuerpo)),
        new Promise((_, no) => corte.signal.addEventListener('abort', () => no(Object.assign(new Error('tardó'), { name: 'AbortError' })))),
      ]);
    }
    const texto = (datos.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    const sale = JSON.parse(texto);
    const reescrito = typeof sale.texto === 'string' ? sale.texto.trim().slice(0, 500) : '';
    console.log(`IA: "${contexto.mensaje}" → ${sale.entendido && reescrito ? `"${reescrito}"` : '(no entendió)'}`);
    return sale.entendido === true && reescrito ? reescrito : null;
  } catch (e) {
    console.error(`IA: ${e.name === 'AbortError' ? 'Gemini tardó demasiado' : e.message}`);
    return null;
  } finally {
    clearTimeout(reloj);
  }
}

module.exports = { reescribir, disponible, INSTRUCCIONES };
