// Los menús numerados como encuesta de WhatsApp (`src/core/opciones.js`, El dueño, 2026-10-11): qué se manda como texto, cuál
// es la pregunta y las opciones, con los mensajes reales del bot.
const { separarOpciones } = require('../src/core/opciones');

let fallas = 0;
const chequear = (n, c) => { if (c) console.log(`  ✔ ${n}`); else { console.log(`  ✘ FALLÓ: ${n}`); fallas++; } };
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const menu = separarOpciones('¡Hola! 👋 Soy el asistente de *Nails Sofi*.\n\n¿Qué necesitás?\n\n*1* — Reservar un turno 💅\n*2* — Ver precios\n*3* — Ubicación y horarios\n*4* — Hablar con una persona\n\nRespondé con el número.');
chequear('el menú: la pregunta es la encuesta y el saludo va como texto', menu.pregunta === '¿Qué necesitás?' && menu.texto === '¡Hola! 👋 Soy el asistente de *Nails Sofi*.');
chequear('el menú: cuatro opciones con su número, sin negrita', igual(menu.opciones.map((o) => o.numero), [1, 2, 3, 4]) && menu.opciones[0].texto === 'Reservar un turno 💅');

const dias = separarOpciones('*Kapping* ($18000) 👌\n¿Qué día te queda bien?\n\n*1* — mañana jueves 15\n*2* — viernes 16\n\nRespondé con el número, *0* para volver o *menú* para empezar de nuevo.');
chequear('los días: "*0* para volver" se sigue diciendo, sin "respondé con el número"', dias.texto === '*Kapping* ($18000) 👌\n\nSi no, escribí *0* para volver o *menú* para empezar de nuevo.');
chequear('los días: la pregunta', dias.pregunta === '¿Qué día te queda bien?');

const confirmar = separarOpciones('Perfecto Ana, repasemos:\n\n💅 Kapping\n📅 jueves 15 a las 10:00\n💰 $18000\n\n*1* — Confirmar\n*2* — Cambiar\n*0* — Cancelar');
chequear('confirmar: el resumen entero va como texto y la encuesta pregunta en general', confirmar.texto.startsWith('Perfecto Ana, repasemos:') && confirmar.texto.includes('💰 $18000') && confirmar.pregunta === 'Elegí una opción');
chequear('confirmar: el 0 también es opción', igual(confirmar.opciones.map((o) => o.numero), [1, 2, 0]));

const servicios = separarOpciones('¡Buenísimo! ¿Qué servicio querés?\n\n*1* — Kapping (60 min) $18000 — seña $5000\n*2* — Esmaltado (45 min) $12000\n\nRespondé con el número (o *menú* para volver al principio).');
chequear('servicios: la pregunta dentro de la misma línea del saludo', servicios.pregunta === '¡Buenísimo! ¿Qué servicio querés?' && servicios.texto === 'Si no, escribí *menú* para volver al principio.');
chequear('servicios: la opción conserva el "—" de adentro', servicios.opciones[0].texto === 'Kapping (60 min) $18000 — seña $5000');

chequear('sin menú: nada que partir', separarOpciones('¡Turno confirmado! 🎉') === null);
chequear('una sola opción no es encuesta', separarOpciones('Elegí:\n*1* — Sí') === null);
const muchas = Array.from({ length: 13 }, (_, i) => `*${i + 1}* — ${String(9 + i).padStart(2, '0')}:00`).join('\n');
chequear('más de 12 opciones no entra en una encuesta: queda el texto', separarOpciones(`Horarios:\n\n${muchas}`) === null);
chequear('opciones repetidas no se pueden distinguir al votar', separarOpciones('¿Cuál?\n*1* — Corte\n*2* — Corte') === null);

console.log(fallas ? `\n❌ ${fallas} chequeos de opciones fallaron` : '\n✅ Opciones OK');
process.exit(fallas ? 1 : 0);
