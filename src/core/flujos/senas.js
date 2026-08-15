// Verificación de señas: OCR + reglas. Devuelve mensajes para clienta y dueña.
const ocr = require('../ocr');
const qSenas = require('../../db/consultas/senas');
const qTurnos = require('../../db/consultas/turnos');
const fechas = require('../fechas');
const notif = require('../notificaciones');

// Procesa la foto del comprobante de un turno pendiente de seña.
// msj: { rutaImagen, texto (caption) }. Devuelve { salientes: [...], estadoFinal }.
function procesarComprobante(config, clienta, turnoId, msj) {
  const turno = qTurnos.porId(turnoId);
  const sena = qSenas.porTurno(turnoId);
  const salientes = [];

  // 1) OCR con binario nativo; si no hay, usamos el texto que acompaña la foto
  //    (modo demo / respaldo). Si no hay nada legible → a revisar.
  const textoOcr = ocr.extraerTexto(msj.rutaImagen) || msj.texto || '';
  const datos = ocr.parsear(textoOcr);

  // 2) Reglas de verificación
  let estado = 'verificado';
  let motivo = null;

  if (!textoOcr.trim()) {
    estado = 'a_revisar'; motivo = 'No se pudo leer el comprobante';
  } else if (datos.nroOperacion && qSenas.existeOperacion(datos.nroOperacion)) {
    estado = 'a_revisar'; motivo = `Comprobante DUPLICADO (operación ${datos.nroOperacion} ya usada)`;
    datos.nroOperacion = null; // no pisamos el UNIQUE existente
  } else if (!datos.nroOperacion) {
    estado = 'a_revisar'; motivo = 'No se encontró número de operación';
  } else if (datos.monto == null || datos.monto < sena.monto_esperado) {
    estado = 'a_revisar';
    motivo = `Monto detectado ($${datos.monto ?? '?'}) menor a la seña ($${sena.monto_esperado})`;
  } else if (config.senas.titular &&
             !ocr.normalizar(datos.destinatario).includes(ocr.normalizar(config.senas.titular))) {
    estado = 'a_revisar';
    motivo = `Destinatario "${datos.destinatario || '?'}" no coincide con "${config.senas.titular}"`;
  }

  qSenas.resolver(sena.id, {
    estado, monto: datos.monto, destinatario: datos.destinatario,
    nroOperacion: datos.nroOperacion, fecha: datos.fecha,
    rutaImagen: msj.rutaImagen, ocrTexto: textoOcr, motivo, por: 'ocr',
  });

  if (estado === 'verificado') {
    qTurnos.cambiarEstado(turnoId, 'confirmado');
    salientes.push({
      para: clienta.telefono,
      texto: `¡Listo! Seña recibida ✅\nTu turno quedó confirmado:\n📅 ${fechas.diaLindo(turno.inicio.slice(0, 10))} a las ${turno.inicio.slice(11)}\n💅 ${turno.servicio}\n\nTe mandamos un recordatorio un día antes. ¡Te esperamos!`,
    });
    salientes.push(notif.turnoSenado(config, turno, datos, msj.rutaImagen));
    salientes.push(...notif.invitacionCalendario(config, qTurnos.porId(turnoId)));
    salientes.push(...notif.tarjetaContacto(config, clienta, turno));
  } else {
    salientes.push({
      para: clienta.telefono,
      texto: `Recibimos tu comprobante 🙌\nLo estamos verificando y te confirmamos el turno enseguida.`,
    });
    salientes.push(notif.senaARevisar(config, turno, motivo, msj.rutaImagen));
  }

  return { salientes, estadoFinal: estado };
}

// Vence señas cuya espera superó el límite: libera el horario y avisa a ambas.
function vencerPendientes(config) {
  const salientes = [];
  const ahora = fechas.aTexto(fechas.ahora());
  for (const sena of qSenas.vencidas(ahora)) {
    const turno = qTurnos.porId(sena.turno_id);
    if (!turno || turno.estado !== 'pendiente_sena') continue;
    qSenas.cambiarEstado(sena.id, 'vencido', 'sistema');
    qTurnos.cambiarEstado(turno.id, 'vencido');
    salientes.push({
      para: turno.telefono,
      texto: `Pasaron ${config.senas.vencimiento_horas} hs y no recibimos el comprobante, así que el turno del ${fechas.diaLindo(turno.inicio.slice(0, 10))} ${turno.inicio.slice(11)} se liberó 😕\nSi todavía lo querés, escribí *hola* y lo reservamos de nuevo.`,
    });
    salientes.push(notif.senaVencida(config, turno));
  }
  return salientes;
}

module.exports = { procesarComprobante, vencerPendientes };
