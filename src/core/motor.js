// Motor: única puerta de entrada del núcleo. El adaptador de WhatsApp le pasa
// mensajes "planos" y recibe una lista de mensajes salientes. El núcleo no
// sabe nada de whatsapp-web.js ni de Baileys.
//
// Mensaje entrante:  { de, texto, rutaImagen?, productoId?, tipo? }   (tipo 'audio': una nota de voz)
// Mensaje saliente:  { para, texto, imagenRuta? }
const qClientas = require('../db/consultas/clientas');
const maquina = require('./maquina');
const comercio = require('./comercio');
const duena = require('./duena');

// Modo prueba: el dueño se escribe con el bot como si fuera un cliente, en el WhatsApp de verdad, y el resto no recibe
// respuesta (el bot todavía no está listo para atenderlos, o se está probando un cambio). En memoria a propósito: si el
// bot se reinicia vuelve a atender a todos, y si el dueño se olvida de salir, se apaga solo. Dejar a los clientes
// reales sin respuesta por un olvido es peor que tener que volver a entrar.
const HORAS_PRUEBA = 2;
const ENTRAR_PRUEBA = /^!?\s*(modo\s+)?prueba$/;
const SALIR_PRUEBA = /^!?\s*(salir(\s+(de\s+)?(la\s+)?prueba)?|modo\s+normal|fin\s+(de\s+)?(la\s+)?prueba)$/;
const normal = (t) => (t || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[.!¡?¿]+$/, '');

function crearMotor(config) {
  let pruebaHasta = 0;
  const enPrueba = () => Date.now() < pruebaHasta;

  function procesarMensaje(msj) {
    if (msj.de === config.numero_duena) {
      const t = normal(msj.texto);
      if (enPrueba()) {
        if (SALIR_PRUEBA.test(t) || ENTRAR_PRUEBA.test(t)) {
          pruebaHasta = 0;
          return [{ para: config.numero_duena, texto: '✅ Salí del modo prueba: vuelvo a atender a todos y a vos te hablo como dueño.' }];
        }
        pruebaHasta = Date.now() + HORAS_PRUEBA * 3600000;
        return comoCliente(qClientas.obtenerOCrear(msj.de), msj);
      }
      if (ENTRAR_PRUEBA.test(t)) {
        pruebaHasta = Date.now() + HORAS_PRUEBA * 3600000;
        // Arranca como un cliente nuevo, para probar la charla desde el saludo (una pausa de 0 minutos vence ya y
        // limpia la charla de la prueba anterior).
        qClientas.derivar(qClientas.obtenerOCrear(msj.de).id, 0);
        return [{ para: config.numero_duena, texto:
          `🧪 *Modo prueba*: ahora te contesto como a un cliente y al resto no le respondo.\n\n` +
          (config.forma === 'productos'
            ? 'Ojo: un pedido que confirmes llega de verdad a la app (Encargues); cancelalo ahí.\n\n' : '') +
          `Para volver, escribí *salir*. Si no, se apaga solo en ${HORAS_PRUEBA} horas sin escribirme.` }];
      }
      // La dueña se identifica por número y tiene su propio set de comandos.
      return duena.procesar(config, msj);
    }
    // Mi número de soporte tampoco entra al flujo de clienta.
    if (msj.de === config.numero_soporte) return [];
    if (enPrueba()) return [];

    return comoCliente(qClientas.obtenerOCrear(msj.de), msj);
  }

  function comoCliente(clienta, msj) {
    // Derivada a humano: el bot calla mientras la dueña atiende a mano.
    if (qClientas.estaDerivada(clienta)) return [];

    // Un audio: el bot no lo puede escuchar. Callarse es lo peor (el cliente cree que lo ignoran): se le pide que lo
    // escriba, sin perder el paso en el que estaba.
    if (msj.tipo === 'audio') {
      return [{ para: clienta.telefono,
        texto: `🎤 Perdón, no puedo escuchar audios. ¿Me lo escribís? Si preferís hablar con ${config.textos.quien_atiende}, escribí *hablar con alguien*.` }];
    }

    // Un comercio (almacén, kiosco…) atiende consultas y pedidos; una barbería o un salón de uñas, turnos. Se lee cada
    // vez: la configuración se puede recargar desde Nodo Sur sin reiniciar.
    return config.forma === 'productos'
      ? comercio.procesar(config, clienta, msj)
      : maquina.procesar(config, clienta, msj);
  }

  // El dueño contestó a mano en el chat de [numero] (desde el WhatsApp del negocio): el bot se calla ahí un rato
  // (config.pausa_minutos) para no pisarlo.
  function pausar(numero) {
    if (!numero || numero === config.numero_duena || numero === config.numero_soporte) return;
    const clienta = qClientas.obtenerOCrear(numero);
    qClientas.derivar(clienta.id, config.pausa_minutos);
  }

  // Lo mismo, con la IA para lo que no entiende (src/ia.js): si el comercio pidió reescribir el mensaje, se le pregunta a la IA
  // y se vuelve a procesar el mensaje reescrito; si la IA no pudo, el original como si no hubiera IA. `reescribir(contexto)`
  // devuelve el texto o null.
  async function procesarConIA(msj, reescribir) {
    const salientes = procesarMensaje(msj);
    const pedido = salientes.find((s) => s.ia);
    if (!pedido) return salientes;
    let texto = null;
    try { texto = await reescribir(pedido.ia); } catch (e) { console.error(`IA: ${e.message}`); }
    return procesarMensaje(texto ? { ...msj, texto, reescrito: true, original: msj.texto } : { ...msj, sinIA: true });
  }

  return { procesarMensaje, procesarConIA, pausar, enPrueba };
}

module.exports = { crearMotor };
