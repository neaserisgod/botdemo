// OCR de comprobantes. En Termux usa el binario nativo `tesseract` (pkg install
// tesseract). Si no está (demo en PC), cae al texto que venga con la foto
// (caption) — así la demo se puede mostrar sin Tesseract instalado.
const { execFileSync } = require('child_process');
const fs = require('fs');

function correrTesseract(rutaImagen, args) {
  const salida = execFileSync('tesseract', [rutaImagen, 'stdout', ...args], {
    timeout: 30000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
  });
  return salida.trim() || null;
}

function extraerTexto(rutaImagen) {
  if (!rutaImagen || !fs.existsSync(rutaImagen)) return null;
  // 1º en español; si no está el paquete de idioma, con el default (eng):
  // los montos y números de operación salen igual.
  try { return correrTesseract(rutaImagen, ['-l', 'spa']); } catch { /* sigue */ }
  try { return correrTesseract(rutaImagen, []); } catch { /* sin tesseract */ }
  return null; // el llamador cae al texto que acompaña la foto
}

// Saca monto, destinatario, nº de operación y fecha del texto del comprobante.
// Formatos típicos de Mercado Pago / bancos argentinos.
function parsear(texto) {
  if (!texto) return { monto: null, destinatario: null, nroOperacion: null, fecha: null };
  const t = texto.replace(/\r/g, '');

  // Monto: "$ 5.000", "$5000,00", "ARS 5.000"
  let monto = null;
  const m = t.match(/(?:\$|ARS)\s*([\d.]+(?:,\d{1,2})?)/i);
  if (m) monto = Math.round(parseFloat(m[1].replace(/\./g, '').replace(',', '.')));

  // Destinatario: "Para Maria Ejemplo", "Destinatario: ..."
  let destinatario = null;
  const d = t.match(/(?:para|destinatario|a nombre de)[:\s]+([A-Za-zÁÉÍÓÚáéíóúÑñ][A-Za-zÁÉÍÓÚáéíóúÑñ .]{2,40})/i);
  if (d) destinatario = d[1].trim();

  // Nº de operación. Formato real de MP: "Número de operación de Mercado Pago"
  // y el número EN LA LÍNEA SIGUIENTE. Además el OCR en inglés lee "operacién"
  // (la ó como é), por eso operaci\S{1,2}. [^0-9]{0,40} salta las palabras
  // intermedias hasta el primer número largo (6+ dígitos, así no agarra fechas).
  let nroOperacion = null;
  const o = t.match(/(?:operaci\S{1,2}|transacci\S{1,2}|comprobante)[^0-9]{0,40}([0-9]{6,20})/i);
  if (o) nroOperacion = o[1];

  // Fecha: "12/08/2026" o "13 de agosto de 2026" (formato MP)
  let fecha = null;
  const f = t.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  if (f) fecha = f[1];
  if (!fecha) {
    const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
      'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const fm = t.match(new RegExp(`(\\d{1,2}) de (${MESES.join('|')})(?: de (\\d{4}))?`, 'i'));
    if (fm) {
      const mes = MESES.indexOf(fm[2].toLowerCase()) + 1;
      fecha = `${fm[1]}/${mes}/${fm[3] || new Date().getFullYear()}`;
    }
  }

  return { monto, destinatario, nroOperacion, fecha };
}

// Normaliza para comparar nombres sin tildes ni mayúsculas.
function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

module.exports = { extraerTexto, parsear, normalizar };
