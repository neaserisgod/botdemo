// Suite: la zona horaria del bot (`src/zona.js`). Un Node sin zona arranca en UTC y el bot no ofrecía turnos para hoy.
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

const ZONA = path.join(__dirname, '..', 'src', 'zona.js');
// Corre en un Node aparte, con el entorno que se le pase: así se prueba de verdad "arrancar sin TZ".
const horaLocal = (env) => execFileSync(process.execPath, ['-e', `
  const z = require(${JSON.stringify(ZONA)}).asegurarZona();
  // 18:00 UTC del 13/10/2026: en Argentina son las 15:00.
  process.stdout.write(z + ' ' + new Date(Date.UTC(2026, 9, 13, 18, 0)).getHours());
`], { env }).toString();

let ok = 0;
const t = (nombre, fn) => { fn(); ok++; console.log('  ✔ ' + nombre); };

const sinTz = { ...process.env }; delete sinTz.TZ;
t('sin TZ y sin zona del sistema: usa la de Argentina (hoy son las 15, no las 18)', () => {
  const [zona, hora] = horaLocal({ ...sinTz, TZ: '' }).split(' ');
  // TZ vacía cuenta como "sin zona": en este contenedor la del sistema es UTC.
  if (Intl.DateTimeFormat().resolvedOptions().timeZone.startsWith('Etc/') || Intl.DateTimeFormat().resolvedOptions().timeZone === 'UTC') {
    assert.strictEqual(zona, 'America/Argentina/Buenos_Aires');
    assert.strictEqual(hora, '15');
  }
});
t('con TZ puesta (la que pasa la app): la respeta', () => {
  assert.strictEqual(horaLocal({ ...sinTz, TZ: 'America/Argentina/Cordoba' }), 'America/Argentina/Cordoba 15');
  assert.strictEqual(horaLocal({ ...sinTz, TZ: 'Europe/Madrid' }), 'Europe/Madrid 20');
});
// Lo mismo con los certificados (`src/certificados.js`, 2026-10-21): en Android, los que trae Node; en una PC, los del sistema.
t('certificados: en Android usa los que trae Node, en una PC no toca nada', () => {
  const tls = require('tls');
  const { asegurarCertificados } = require('../src/certificados');
  assert.strictEqual(asegurarCertificados('linux'), false);
  const cargo = asegurarCertificados('android');
  assert.strictEqual(cargo, typeof tls.setDefaultCACertificates === 'function');
  if (cargo) assert.strictEqual(tls.getCACertificates('default').length, tls.rootCertificates.length);
});
console.log(`\n✅ Zona horaria OK (${ok})`);
