// Motor: única puerta de entrada del núcleo. El adaptador de WhatsApp le pasa
// mensajes "planos" y recibe una lista de mensajes salientes. El núcleo no
// sabe nada de whatsapp-web.js ni de Baileys.
//
// Mensaje entrante:  { de, texto, rutaImagen?, productoId? }
// Mensaje saliente:  { para, texto, imagenRuta? }
//
// Asincrónico (Nodo Sur, docs/PLAN-SERVICIOS.md etapa 5): la conversación de turnos va a reservar el horario contra el
// servidor, por red. Por eso los mensajes de un MISMO número se procesan de a uno y en orden (una cola por número): dos
// mensajes seguidos de la misma persona no se pisan el estado de la charla mientras el primero espera la red.
const qClientas = require('../db/consultas/clientas');
const maquina = require('./maquina');
const comercio = require('./comercio');
const duena = require('./duena');

function crearMotor(config) {
  const colas = new Map();

  // Devuelve una promesa con los mensajes salientes.
  function procesarMensaje(msj) {
    const de = msj.de;
    const previa = colas.get(de) || Promise.resolve();
    const esta = previa.then(() => procesarAhora(msj));
    const fin = esta.catch(() => {});
    colas.set(de, fin);
    // La cola de un número que ya no tiene nada pendiente se suelta, así el mapa no crece con cada número que escribió.
    fin.then(() => { if (colas.get(de) === fin) colas.delete(de); });
    return esta;
  }

  async function procesarAhora(msj) {
    // La dueña se identifica por número y tiene su propio set de comandos.
    if (msj.de === config.numero_duena) {
      return duena.procesar(config, msj);
    }
    // Mi número de soporte tampoco entra al flujo de clienta.
    if (msj.de === config.numero_soporte) return [];

    const clienta = qClientas.obtenerOCrear(msj.de);

    // Derivada a humano: el bot calla mientras la dueña atiende a mano.
    if (qClientas.estaDerivada(clienta)) return [];

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
