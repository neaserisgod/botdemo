// El pin del local (`src/mapa.js`, El dueño, 2026-10-11): las coordenadas que trae un link de Google Maps, y seguir el link
// corto de "Compartir" sin salir a internet en la prueba.
const { coordenadasDeTexto, resolverCoordenadas } = require('../src/mapa');
const faq = require('../src/core/flujos/faq');

let fallas = 0;
const chequear = (n, c) => { if (c) console.log(`  ✔ ${n}`); else { console.log(`  ✘ FALLÓ: ${n}`); fallas++; } };
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

chequear('el punto marcado (!3d…!4d…) gana al centro del mapa',
  igual(coordenadasDeTexto('https://www.google.com/maps/place/Mitre+150/@-41.1300,-71.3000,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d-41.1335!4d-71.3103'), { lat: -41.1335, lng: -71.3103 }));
chequear('el centro del mapa (@lat,lng)', igual(coordenadasDeTexto('https://www.google.com/maps/@-41.1335,-71.3103,15z'), { lat: -41.1335, lng: -71.3103 }));
chequear('q=lat,lng (también con la coma codificada)', igual(coordenadasDeTexto('https://maps.google.com/?q=-41.1335%2C-71.3103'), { lat: -41.1335, lng: -71.3103 }));
chequear('pegadas a mano', igual(coordenadasDeTexto(' -41.1335, -71.3103 '), { lat: -41.1335, lng: -71.3103 }));
chequear('un link corto no trae coordenadas', coordenadasDeTexto('https://maps.app.goo.gl/abc123') === null);
chequear('texto cualquiera', coordenadasDeTexto('Mitre 150') === null && coordenadasDeTexto('') === null && coordenadasDeTexto(undefined) === null);

(async () => {
  let pedidos = 0;
  const buscar = async (url) => { pedidos++; return { url: 'https://www.google.com/maps/place/X/@-41.1,-71.2,17z/data=!3d-41.1335!4d-71.3103', text: async () => '' }; };
  const config = { negocio: { nombre: 'Nails Sofi', direccion: 'Mitre 150', ubicacion_maps: 'https://maps.app.goo.gl/abc123' } };
  await resolverCoordenadas(config, { buscar });
  chequear('el link corto se sigue y quedan las coordenadas', igual(config.negocio.coordenadas, { lat: -41.1335, lng: -71.3103 }));
  const otra = { negocio: { ...config.negocio, coordenadas: undefined } };
  await resolverCoordenadas(otra, { buscar });
  chequear('el mismo link no sale de nuevo a internet (recargar la configuración)', pedidos === 1 && otra.negocio.coordenadas.lat === -41.1335);

  const sinRed = { negocio: { nombre: 'X', ubicacion_maps: 'https://maps.app.goo.gl/otro' } };
  await resolverCoordenadas(sinRed, { buscar: async () => { throw new Error('sin red'); } });
  chequear('sin red: sin pin, no rompe', !sinRed.negocio.coordenadas);

  const sal = faq.conPin([{ para: '549', texto: '📍' }], config);
  chequear('la respuesta de ubicación lleva el pin', igual(sal[0].ubicacion, { lat: -41.1335, lng: -71.3103, nombre: 'Nails Sofi', direccion: 'Mitre 150' }));
  chequear('sin coordenadas, sin pin', !faq.conPin([{ para: '549', texto: '📍' }], { negocio: {} })[0].ubicacion);
  const texto = faq.ubicacionYHorarios({ negocio: { nombre: 'X', direccion: '', ubicacion_maps: '' }, horarios: { lunes: { desde: '09:00', hasta: '18:00' } } });
  chequear('sin dirección ni link no quedan renglones vacíos', texto.startsWith('📍 *X*\n\n🕐'));

  console.log(fallas ? `\n❌ ${fallas} chequeos del mapa fallaron` : '\n✅ Mapa OK');
  process.exit(fallas ? 1 : 0);
})();
