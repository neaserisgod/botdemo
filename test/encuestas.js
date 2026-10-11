// Los votos de las encuestas (`src/adaptadores/encuestas.js`, El dueño, 2026-10-11): un voto cifrado como lo cifra WhatsApp
// se descifra con la función de Baileys aunque no se sepa de antemano con qué identidad (número o @lid) votó; solo vale la
// última encuesta de cada persona, una sola vez.
const crypto = require('crypto');
const { crearRegistroEncuestas, descifrarVoto, hashDeOpcion } = require('../src/adaptadores/encuestas');

let fallas = 0;
const chequear = (n, c) => { if (c) console.log(`  ✔ ${n}`); else { console.log(`  ✘ FALLÓ: ${n}`); fallas++; } };

(async () => {
  const b = await import('@whiskeysockets/baileys');
  const opciones = [{ numero: 1, texto: 'Reservar un turno 💅' }, { numero: 2, texto: 'Ver precios' }, { numero: 0, texto: 'Cancelar' }];

  // Cifrar un voto como lo hace el celular de la clienta (lo inverso de decryptPollVote).
  function cifrarVoto(nombreOpcion, { secreto, idEncuesta, creador, votante }) {
    const sign = Buffer.concat([Buffer.from(idEncuesta), Buffer.from(creador), Buffer.from(votante), Buffer.from('Poll Vote'), new Uint8Array([1])]);
    const key0 = b.hmacSign(secreto, new Uint8Array(32), 'sha256');
    const decKey = b.hmacSign(sign, key0, 'sha256');
    const iv = crypto.randomBytes(12);
    const plano = b.proto.Message.PollVoteMessage.encode({ selectedOptions: nombreOpcion ? [Buffer.from(hashDeOpcion(nombreOpcion), 'hex')] : [] }).finish();
    return { encPayload: b.aesEncryptGCM(plano, decKey, iv, Buffer.from(`${idEncuesta}\u0000${votante}`)), encIv: iv };
  }

  const secreto = crypto.randomBytes(32);
  const registro = crearRegistroEncuestas();
  registro.registrar('ENC1', '5492944111111', opciones, {});
  const voto = cifrarVoto('Ver precios', { secreto, idEncuesta: 'ENC1', creador: '123456@lid', votante: '987654@lid' });

  const descifrado = descifrarVoto(b.decryptPollVote, {
    voto, secreto, idEncuesta: 'ENC1',
    creadores: ['5492944000000@s.whatsapp.net', '123456@lid'],
    votantes: ['5492944111111@s.whatsapp.net', '987654@lid'],
  });
  chequear('el voto se descifra aunque las dos identidades sean @lid', !!descifrado);
  chequear('y dice la opción votada: el número 2', registro.vigente('ENC1', '5492944111111') && registro.votar('ENC1', descifrado.selectedOptions) === 2);
  chequear('la misma encuesta no se vota dos veces', registro.vigente('ENC1', '5492944111111') === null && registro.votar('ENC1', descifrado.selectedOptions) === null);

  chequear('con las identidades equivocadas no descifra (no inventa un voto)', descifrarVoto(b.decryptPollVote, {
    voto, secreto, idEncuesta: 'ENC1', creadores: ['5492944000000@s.whatsapp.net'], votantes: ['5492944111111@s.whatsapp.net'],
  }) === null);

  registro.registrar('ENC2', '5492944111111', opciones, {});
  registro.registrar('ENC3', '5492944111111', opciones, {});
  chequear('una encuesta vieja (ya le mandé otra) no vale', registro.vigente('ENC2', '5492944111111') === null && !!registro.vigente('ENC3', '5492944111111'));
  registro.olvidar('5492944111111');
  chequear('después de otro mensaje que no es encuesta, tampoco', registro.vigente('ENC3', '5492944111111') === null);

  registro.registrar('ENC4', '5492944222222', opciones, {});
  const sacado = descifrarVoto(b.decryptPollVote, {
    voto: cifrarVoto(null, { secreto, idEncuesta: 'ENC4', creador: 'a@s.whatsapp.net', votante: 'b@s.whatsapp.net' }),
    secreto, idEncuesta: 'ENC4', creadores: ['a@s.whatsapp.net'], votantes: ['b@s.whatsapp.net'],
  });
  chequear('sacar el voto no elige nada', registro.votar('ENC4', sacado.selectedOptions) === null && !!registro.vigente('ENC4', '5492944222222'));
  chequear('el 0 (Cancelar) también vuelve como 0', registro.votar('ENC4', [Buffer.from(hashDeOpcion('Cancelar'), 'hex')]) === 0);

  // Android reinicia el bot: la encuesta abierta sigue valiendo y el voto se sigue descifrando.
  const os = require('os');
  const path = require('path');
  const ruta = path.join(os.tmpdir(), `encuestas_${Date.now()}.json`);
  const antes = crearRegistroEncuestas({ ruta });
  antes.registrar('ENC9', '5492944333333', opciones, { messageContextInfo: { messageSecret: secreto } });
  await new Promise((r) => setTimeout(r, 700));
  const despues = crearRegistroEncuestas({ ruta });
  const abierta = despues.vigente('ENC9', '5492944333333');
  const v9 = abierta && descifrarVoto(b.decryptPollVote, {
    voto: cifrarVoto('Reservar un turno 💅', { secreto, idEncuesta: 'ENC9', creador: 'x@s.whatsapp.net', votante: 'y@lid' }),
    secreto: abierta.mensaje.messageContextInfo.messageSecret, idEncuesta: 'ENC9', creadores: ['x@s.whatsapp.net'], votantes: ['y@lid'],
  });
  chequear('después de un reinicio, la encuesta abierta sigue valiendo y su voto se lee', !!v9 && despues.votar('ENC9', v9.selectedOptions) === 1);

  console.log(fallas ? `\n❌ ${fallas} chequeos de encuestas fallaron` : '\n✅ Encuestas OK');
  process.exit(fallas ? 1 : 0);
})();
