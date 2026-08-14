// Carga y valida config.json. Si no existe (repo recién clonado), usa
// config.example.json avisando, así el bot arranca igual para probarlo.
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');

function cargar() {
  const propio = path.join(RAIZ, 'config.json');
  const ejemplo = path.join(RAIZ, 'config.example.json');

  let ruta = propio;
  if (!fs.existsSync(propio)) {
    if (!fs.existsSync(ejemplo)) {
      throw new Error('No encontré config.json ni config.example.json');
    }
    ruta = ejemplo;
    console.log('⚠️  No hay config.json: arranco con config.example.json (datos de demo).');
    console.log('   Para un cliente real: copiá config.example.json a config.json y editalo.\n');
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(ruta, 'utf8'));
  } catch (e) {
    throw new Error(`config.json tiene un error de formato JSON: ${e.message}`);
  }

  const problemas = validar(config);
  if (problemas.length) {
    console.error('❌ Revisá config.json:\n' + problemas.map((p) => `   • ${p}`).join('\n') + '\n');
    process.exit(1);
  }
  return config;
}

// Errores de configuración típicos al dar de alta un cliente nuevo.
function validar(c) {
  const malos = [];
  const esNumero = (v) => typeof v === 'string' && /^\d{11,15}$/.test(v);

  for (const campo of ['numero_duena', 'numero_soporte', 'numero_actual']) {
    if (!esNumero(c[campo])) {
      malos.push(`${campo}: tiene que ser solo números con código de país, sin + ni espacios (ej: 5492944123456). Está: "${c[campo]}"`);
    } else if (c[campo].startsWith('54') && !c[campo].startsWith('549')) {
      malos.push(`${campo}: los celulares argentinos van con 549 adelante (está "${c[campo]}")`);
    }
  }
  if (c.numero_duena && c.numero_duena === c.numero_actual) {
    malos.push('numero_duena no puede ser el mismo número del bot: WhatsApp no se escribe a sí mismo');
  }

  if (!Array.isArray(c.servicios) || c.servicios.length === 0) {
    malos.push('servicios: tiene que haber al menos uno');
  } else {
    const ids = new Set();
    for (const s of c.servicios) {
      if (!s.id || !s.nombre) malos.push(`servicios: falta id o nombre en ${JSON.stringify(s)}`);
      if (ids.has(s.id)) malos.push(`servicios: el id ${s.id} está repetido`);
      ids.add(s.id);
      if (!(s.duracion_min > 0)) malos.push(`servicio "${s.nombre}": duracion_min tiene que ser mayor a 0`);
      if (!(s.precio >= 0)) malos.push(`servicio "${s.nombre}": precio inválido`);
      if (s.sena > s.precio) malos.push(`servicio "${s.nombre}": la seña ($${s.sena}) es mayor al precio ($${s.precio})`);
    }
  }

  const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
  let algunDiaAbierto = false;
  for (const d of DIAS) {
    if (!(d in (c.horarios || {}))) { malos.push(`horarios: falta "${d}" (poné null si está cerrado)`); continue; }
    const h = c.horarios[d];
    if (h === null) continue;
    if (!h.desde || !h.hasta) { malos.push(`horarios.${d}: faltan "desde" u "hasta"`); continue; }
    if (!/^\d{2}:\d{2}$/.test(h.desde) || !/^\d{2}:\d{2}$/.test(h.hasta)) {
      malos.push(`horarios.${d}: usá formato HH:MM (ej: "09:00")`);
    } else if (h.desde >= h.hasta) {
      malos.push(`horarios.${d}: "desde" (${h.desde}) tiene que ser anterior a "hasta" (${h.hasta})`);
    } else algunDiaAbierto = true;
  }
  if (!algunDiaAbierto) malos.push('horarios: están todos los días cerrados, el bot no podría agendar nada');

  if (c.senas?.habilitadas) {
    if (!c.senas.alias_mp) malos.push('senas.alias_mp: falta el alias para que transfieran');
    if (!c.senas.titular) malos.push('senas.titular: falta el nombre del titular (se usa para validar el comprobante)');
    if (!(c.senas.vencimiento_horas > 0)) malos.push('senas.vencimiento_horas: tiene que ser mayor a 0');
  }

  if (!(c.turnos?.intervalo_slot_min > 0)) malos.push('turnos.intervalo_slot_min: tiene que ser mayor a 0');
  if (!(c.turnos?.dias_hacia_adelante > 0)) malos.push('turnos.dias_hacia_adelante: tiene que ser mayor a 0');
  if (!(c.panel?.puerto > 0)) malos.push('panel.puerto: falta o es inválido');

  for (const [clave, valor] of [
    ['notificaciones_duena.agenda_diaria_hora', c.notificaciones_duena?.agenda_diaria_hora],
    ['notificaciones_duena.resumen_semanal_hora', c.notificaciones_duena?.resumen_semanal_hora],
    ['latido.hora', c.latido?.hora],
  ]) {
    if (!/^\d{1,2}:\d{2}$/.test(valor || '')) malos.push(`${clave}: usá formato HH:MM (está: "${valor}")`);
  }

  return malos;
}

module.exports = { cargar, validar };
