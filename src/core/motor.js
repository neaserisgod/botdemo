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

function crearMotor(config) {
  function procesarMensaje(msj) {
    // La dueña se identifica por número y tiene su propio set de comandos.
    if (msj.de === config.numero_duena) {
      return duena.procesar(config, msj);
    }
    // Mi número de soporte tampoco entra al flujo de clienta.
    if (msj.de === config.numero_soporte) return [];

    const clienta = qClientas.obtenerOCrear(msj.de);

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

  return { procesarMensaje, pausar };
}

module.exports = { crearMotor };
