// Los certificados raíz con que el bot confía en WhatsApp y en Nodo Sur (primer celular real, 2026-10-21: "fetch failed
// (UNABLE_TO_GET_ISSUER_CERT_LOCALLY)" y "WebSocket Error (unable to get local issuer certificate)" en cada conexión).
//
// El Node que va adentro de la app sale de Termux, y desde nodejs-lts 24.18.0-2 busca los certificados donde los deja Termux
// (su carpeta etc/tls), que adentro de la app no existe: sin certificados no abre ninguna conexión segura. Node trae compilada
// su propia lista (la de Mozilla, `tls.rootCertificates`): en Android se usa esa siempre, venga como venga compilado.
// En una PC o en Termux no se toca: ahí los certificados del sistema existen y pueden traer alguno propio (un proxy).
const tls = require('tls');

function asegurarCertificados(plataforma = process.platform) {
  if (plataforma !== 'android' || typeof tls.setDefaultCACertificates !== 'function') return false;
  try {
    tls.setDefaultCACertificates(tls.rootCertificates);
    return true;
  } catch (e) {
    console.error('No pude cargar los certificados de Node:', e.message);
    return false;
  }
}

module.exports = { asegurarCertificados };
