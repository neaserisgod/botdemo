// Verificación de señas: OCR + reglas. Devuelve mensajes para clienta y dueña.
//
// Un comprobante leído NUNCA confirma el turno solo (Nodo Sur, decisión 12 de docs/PLAN-SERVICIOS.md): una foto se puede
// editar, y el OCR no sabe si la plata llegó. Una seña se confirma sola únicamente cuando cruza con Mercado Pago (el pago del
// link de seña, o la transferencia en los cobros reales de la cuenta; etapa 5). Acá las reglas solo ordenan lo que ve la
// dueña: si todo coincide se lo dice, y si algo no, le dice qué. En los dos casos aprueba ella con !ok.
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

  // 2) Reglas de verificación: todas terminan en "a revisar"; cambia lo que se le dice a la dueña.
  const estado = 'a_revisar';
  let motivo = null;

  if (!textoOcr.trim()) {
    motivo = 'No se pudo leer el comprobante';
  } else if (datos.nroOperacion && qSenas.existeOperacion(datos.nroOperacion)) {
    motivo = `Comprobante DUPLICADO (operación ${datos.nroOperacion} ya usada)`;
    datos.nroOperacion = null; // no pisamos el UNIQUE existente
  } else if (!datos.nroOperacion) {
    motivo = 'No se encontró número de operación';
  } else if (datos.monto == null || datos.monto < sena.monto_esperado) {
    motivo = `Monto detectado ($${datos.monto ?? '?'}) menor a la seña ($${sena.monto_esperado})`;
  } else if (config.senas.titular &&
             !ocr.normalizar(datos.destinatario).includes(ocr.normalizar(config.senas.titular))) {
    motivo = `Destinatario "${datos.destinatario || '?'}" no coincide con "${config.senas.titular}"`;
  }

  qSenas.resolver(sena.id, {
    estado, monto: datos.monto, destinatario: datos.destinatario,
    nroOperacion: datos.nroOperacion, fecha: datos.fecha,
    rutaImagen: msj.rutaImagen, ocrTexto: textoOcr, motivo, por: 'ocr',
  });

  salientes.push({
    para: clienta.telefono,
    texto: `Recibimos tu comprobante 🙌\nLo estamos verificando y te confirmamos el turno enseguida.`,
  });
  salientes.push(motivo
    ? notif.senaARevisar(config, turno, motivo, msj.rutaImagen)
    : notif.senaParaAprobar(config, turno, datos, msj.rutaImagen));

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
