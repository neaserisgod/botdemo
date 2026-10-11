// Las encuestas que manda el bot y los votos que vuelven (adaptador de Baileys; El dueño, 2026-10-11). El menú numerado sale
// como encuesta (`src/core/opciones.js`) y el voto vuelve al núcleo como si la clienta hubiera escrito el número de esa
// opción: los estados de la conversación no se enteran.
//
// Por qué así:
// - Solo vale la ÚLTIMA encuesta que se le mandó a cada persona, y una sola vez: una encuesta vieja que se toca después (el
//   menú de hace una hora, o la de los días cuando ya se eligió el día) mandaría un número que hoy significa otra cosa.
// - El voto llega cifrado. Baileys 7 tiene el descifrado automático comentado (`process-message.js`), así que se hace acá con
//   su `decryptPollVote`. La clave depende de con qué identidad firmó cada lado (el número o el @lid, que WhatsApp mezcla
//   desde 2025): se prueban las combinaciones hasta que una da (el cifrado autenticado falla con la equivocada).
const crypto = require('crypto');
const fs = require('fs');

const MAX_GUARDADAS = 300;

const hashDeOpcion = (nombre) => crypto.createHash('sha256').update(Buffer.from(nombre || '')).digest('hex');

// Con `ruta`, se guarda en disco: Android reinicia el bot (`ServicioBot.kt`) y la encuesta que la clienta tiene abierta tiene
// que seguir valiendo. Se guarda solo lo necesario: a quién, las opciones y el secreto para descifrar el voto.
function crearRegistroEncuestas({ ruta } = {}) {
  const porId = new Map(); // id del mensaje de la encuesta → { para, porHash, mensaje, usada }
  const ultimaDe = new Map(); // número → id de la última encuesta que se le mandó

  if (ruta) {
    try {
      const guardado = JSON.parse(fs.readFileSync(ruta, 'utf8'));
      for (const [id, e] of guardado.encuestas || []) {
        porId.set(id, {
          para: e.para, usada: e.usada,
          porHash: new Map(e.porHash),
          mensaje: { messageContextInfo: { messageSecret: e.secreto ? Buffer.from(e.secreto, 'base64') : undefined } },
        });
      }
      for (const [para, id] of guardado.ultimas || []) ultimaDe.set(para, id);
    } catch { /* primera vez, o archivo roto: se empieza de cero */ }
  }
  let guardando = null;
  const guardar = () => {
    if (!ruta || guardando) return;
    // Varias encuestas seguidas se guardan juntas.
    guardando = setTimeout(() => {
      guardando = null;
      const encuestas = [...porId].map(([id, e]) => [id, {
        para: e.para, usada: e.usada, porHash: [...e.porHash],
        secreto: e.mensaje?.messageContextInfo?.messageSecret ? Buffer.from(e.mensaje.messageContextInfo.messageSecret).toString('base64') : null,
      }]);
      try { fs.writeFileSync(ruta, JSON.stringify({ encuestas, ultimas: [...ultimaDe] })); } catch (err) {
        console.error('No pude guardar las encuestas:', err.message);
      }
    }, 500);
    guardando.unref?.();
  };

  return {
    /** Anota una encuesta recién mandada. `opciones`: [{ numero, texto }] (el texto es el nombre de la opción). */
    registrar(id, para, opciones, mensaje) {
      if (!id) return;
      porId.set(id, { para, mensaje, usada: false, porHash: new Map(opciones.map((o) => [hashDeOpcion(o.texto), o.numero])) });
      ultimaDe.set(para, id);
      if (porId.size > MAX_GUARDADAS) porId.delete(porId.keys().next().value);
      guardar();
    },

    /** Lo que hace falta para descifrar un voto a esa encuesta, o null si no es una encuesta vigente. */
    vigente(id, de) {
      const e = porId.get(id);
      if (!e || e.usada) return null;
      if (ultimaDe.get(e.para) !== id && ultimaDe.get(de) !== id) return null;
      return e;
    },

    /**
     * El número de la opción votada, y la encuesta queda usada. Null si no eligió nada (sacó el voto) o la opción no es de
     * esta encuesta. `elegidas`: los hashes que trae el voto descifrado (`selectedOptions`).
     */
    votar(id, elegidas) {
      const e = porId.get(id);
      if (!e || e.usada || !elegidas?.length) return null;
      const numero = e.porHash.get(Buffer.from(elegidas[0]).toString('hex'));
      if (numero === undefined) return null;
      e.usada = true;
      guardar();
      return numero;
    },

    /** Al mandarle a esa persona un mensaje que no es encuesta, la anterior deja de valer (ya se pasó a otra cosa). */
    olvidar(para) { if (ultimaDe.delete(para)) guardar(); },
  };
}

/**
 * Descifra el voto probando las identidades posibles de quien creó la encuesta (el bot) y de quien votó. Devuelve el voto
 * (`{ selectedOptions }`) o null si ninguna combinación anduvo.
 */
function descifrarVoto(descifrar, { voto, secreto, idEncuesta, creadores, votantes }) {
  if (!voto || !secreto) return null;
  for (const pollCreatorJid of new Set(creadores.filter(Boolean))) {
    for (const voterJid of new Set(votantes.filter(Boolean))) {
      try {
        return descifrar(voto, { pollEncKey: secreto, pollCreatorJid, pollMsgId: idEncuesta, voterJid });
      } catch { /* esa combinación no era */ }
    }
  }
  return null;
}

module.exports = { crearRegistroEncuestas, descifrarVoto, hashDeOpcion };
