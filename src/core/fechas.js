// Utilidades de fecha. Todo en hora local del celu (que se configura con la
// zona del negocio). Formato interno: 'YYYY-MM-DD HH:MM'.

const DIAS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const DIAS_LINDO = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function ahora() {
  return new Date();
}

function aTexto(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function deTexto(t) {
  // 'YYYY-MM-DD HH:MM' → Date local
  const [fecha, hora] = t.split(' ');
  const [a, m, d] = fecha.split('-').map(Number);
  const [h, min] = hora.split(':').map(Number);
  return new Date(a, m - 1, d, h, min);
}

function sumarMinutos(t, min) {
  return aTexto(new Date(deTexto(t).getTime() + min * 60000));
}

function nombreDia(fechaYmd) {
  const [a, m, d] = fechaYmd.split('-').map(Number);
  return DIAS[new Date(a, m - 1, d).getDay()];
}

function diaLindo(fechaYmd) {
  const [a, m, d] = fechaYmd.split('-').map(Number);
  const dt = new Date(a, m - 1, d);
  return `${DIAS_LINDO[dt.getDay()]} ${d}/${m}`;
}

function hoyYmd() {
  return aTexto(ahora()).slice(0, 10);
}

module.exports = { aTexto, deTexto, sumarMinutos, nombreDia, diaLindo, hoyYmd, ahora, DIAS };
