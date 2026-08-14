// OCR de comprobantes. En Termux usa el binario nativo `tesseract` (pkg install
// tesseract). Si no está (demo en PC), cae al texto que venga con la foto
// (caption) — así la demo se puede mostrar sin Tesseract instalado.
const { execFileSync } = require('child_process');
const fs = require('fs');

function extraerTexto(rutaImagen) {
  try {
    if (!rutaImagen || !fs.existsSync(rutaImagen)) return null;
    // -l spa: español. stdout: imprime el texto en vez de escribir archivo.
    const salida = execFileSync('tesseract', [rutaImagen, 'stdout', '-l', 'spa'], {
      timeout: 30000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
    });
    return salida.trim() || null;
  } catch {
    return null; // sin tesseract o falló: el llamador decide qué hacer
  }
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

  // Nº de operación: "Número de operación 123456789", "Operación: #123..."
  let nroOperacion = null;
  const o = t.match(/(?:operaci[oó]n|comprobante|transacci[oó]n)[:\s#Nº°]*([0-9]{6,20})/i);
  if (o) nroOperacion = o[1];

  // Fecha: "12/08/2026" o "12 de agosto"
  let fecha = null;
  const f = t.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  if (f) fecha = f[1];

  return { monto, destinatario, nroOperacion, fecha };
}

// Normaliza para comparar nombres sin tildes ni mayúsculas.
function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

module.exports = { extraerTexto, parsear, normalizar };
