// Carga y valida config.json. Si no existe (repo recién clonado), usa
// config.example.json avisando, así el bot arranca igual para probarlo.
const fs = require('fs');
const path = require('path');

const { PLANTILLAS, plantillaDe, claveDeRubro } = require('./plantillas');

const RAIZ = path.join(__dirname, '..');

function leerJson(ruta) {
  try {
    return JSON.parse(fs.readFileSync(ruta, 'utf8'));
  } catch (e) {
    throw new Error(`${path.basename(ruta)} tiene un error de formato JSON: ${e.message}`);
  }
}

// Mezcla profunda: lo de config.local.json pisa lo de config.json, campo por
// campo (no reemplaza objetos enteros). Los arrays sí se reemplazan completos,
// que es lo que se espera al redefinir "servicios".
function mezclar(base, encima) {
  const r = { ...base };
  for (const [k, v] of Object.entries(encima || {})) {
    r[k] = (v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && !Array.isArray(base[k]))
      ? mezclar(base[k], v)
      : v;
  }
  return r;
}

// La configuración se arma en capas, de menor a mayor prioridad:
//
//   1. config.example.json    ← versionado. La plantilla con TODOS los campos.
//                               Al agregarse funciones nuevas, los valores por
//                               defecto llegan por acá con un simple git pull.
//   2. config.json            ← NO versionado. Lo del cliente de este equipo.
//   3. data/config-nube.json  ← lo que se configura desde la app de Nodo Sur
//                               (lo baja `nube/sincronizar.js`). Gana sobre
//                               config.json: si el negocio lo configura desde
//                               la app, eso es lo que vale. Queda guardado, así
//                               que sin internet sigue andando lo último.
//   4. config.local.json      ← NO versionado. Ajustes finos, opcional.
//
// Que las capas 2 a 4 estén fuera del repo es lo que hace que `git pull` nunca
// choque ni pise los datos del cliente. Y que la capa 1 sea la base es lo que
// hace que una config vieja no se rompa cuando el bot suma opciones nuevas.
const rutaNube = () => path.join(require('./nube/cuenta').dirDatos(), 'config-nube.json');

// Lee las capas que haya y aplica la plantilla del rubro. No valida ni corta el proceso.
function construir() {
  const ejemplo = path.join(RAIZ, 'config.example.json');
  const propio = path.join(RAIZ, 'config.json');
  const local = path.join(RAIZ, 'config.local.json');

  if (!fs.existsSync(ejemplo) && !fs.existsSync(propio)) {
    throw new Error('No encontré config.example.json ni config.json');
  }

  let config = fs.existsSync(ejemplo) ? leerJson(ejemplo) : {};
  const capas = [];

  if (fs.existsSync(propio)) {
    config = mezclar(config, leerJson(propio));
    capas.push('config.json');
  }
  const nube = configNube();
  if (nube) {
    config = mezclar(config, nube.config);
    capas.push(`Nodo Sur (versión ${nube.version})`);
  }
  if (fs.existsSync(local)) {
    config = mezclar(config, leerJson(local));
    capas.push('config.local.json');
  }
  return { config: aplicarPlantilla(config), capas };
}

// La configuración que bajó de Nodo Sur ({ version, config }), o null si no hay o está rota (se ignora, no corta).
function configNube() {
  try {
    const n = JSON.parse(fs.readFileSync(rutaNube(), 'utf8'));
    return n && n.config && typeof n.config === 'object' ? n : null;
  } catch { return null; }
}

function cargar() {
  const { config, capas } = construir();
  if (capas.length) {
    console.log(`Configuración: config.example.json + ${capas.join(' + ')}`);
  } else {
    console.log('⚠️  Solo hay config.example.json (datos de demo).');
    console.log('   Para un cliente real: node scripts/config-de-rubro.js <rubro> && nano config.json\n');
  }
  const problemas = validar(config);
  if (problemas.length) {
    console.error('❌ Revisá config.json:\n' + problemas.map((p) => `   • ${p}`).join('\n') + '\n');
    process.exit(1);
  }
  return config;
}

// Vuelve a leer las capas (por ejemplo, cuando cambió la configuración en Nodo Sur) y cambia [actual] EN EL LUGAR: el
// motor, la conversación y las tareas tienen la misma referencia y ven lo nuevo sin reiniciar. Si lo nuevo no pasa la
// validación, [actual] queda como estaba y se devuelven los problemas.
function recargar(actual) {
  const { config } = construir();
  const problemas = validar(config);
  if (problemas.length) return problemas;
  for (const k of Object.keys(actual)) delete actual[k];
  Object.assign(actual, config);
  return [];
}

// Los textos del rubro van DEBAJO de lo que haya en config.json: la plantilla
// da cómo habla el bot en una barbería o un salón de uñas, y cada negocio
// puede pisar cualquier texto en "textos" (ej. "quien_atiende": "Juli").
function aplicarPlantilla(config) {
  const plantilla = plantillaDe(config.negocio?.rubro);
  if (!plantilla) return config; // validar() lo informa
  return {
    ...config,
    negocio: { ...config.negocio, rubro: claveDeRubro(config.negocio.rubro) },
    // Lo decide el rubro, no config.json: un almacén no da turnos y una barbería no toma pedidos de productos.
    forma: plantilla.forma,
    textos: mezclar(plantilla.textos, config.textos || {}),
  };
}

// Arma la configuración a partir de objetos ya leídos (en orden de prioridad),
// sin tocar archivos ni cortar el proceso. Para los tests y los scripts.
function armar(...capas) {
  let config = {};
  for (const capa of capas) config = mezclar(config, capa);
  return aplicarPlantilla(config);
}

function ejemplo() {
  return leerJson(path.join(RAIZ, 'config.example.json'));
}

// Errores de configuración típicos al dar de alta un cliente nuevo.
function validar(c) {
  const malos = [];
  if (!plantillaDe(c.negocio?.rubro)) {
    malos.push(`negocio.rubro: tiene que ser uno de ${Object.keys(PLANTILLAS).join(', ')} (está: "${c.negocio?.rubro}")`);
  }
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

  // Un comercio (forma productos) no tiene servicios: lo que vende sale del catálogo de Nodo Sur.
  if (c.forma === 'productos') {
    // nada que revisar en servicios
  } else if (!Array.isArray(c.servicios) || c.servicios.length === 0) {
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

  if (!(Number.isInteger(c.pausa_minutos) && c.pausa_minutos >= 5 && c.pausa_minutos <= 24 * 60)) {
    malos.push(`pausa_minutos: cuánto se calla el bot en un chat, entre 5 y 1440 minutos (está: "${c.pausa_minutos}")`);
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

module.exports = { cargar, recargar, construir, validar, armar, ejemplo, mezclar, rutaNube, configNube };
