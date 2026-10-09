// Plantillas por rubro: cómo habla el bot en cada tipo de negocio y con qué
// servicios de ejemplo arranca uno nuevo.
//
// Por qué existe: el bot nació para un salón de uñas y tenía el 💅, "clienta"
// y "la dueña" escritos en el código. En una barbería eso queda mal. Ahora
// cada texto que depende del rubro sale de acá, y config.json puede pisar
// cualquiera en su sección "textos" (ej. "quien_atiende": "Juli").
//
// Los alias son otras formas de nombrar un servicio ("un fade", "kapping"):
// solo los que no se confunden con otro servicio del mismo rubro.
//
// Los servicios de ejemplo son los del mock de servicios de Nodo Sur
// (Nodo-Sur-Pos/docs/mock-servicios). La seña es el 30 % del precio,
// redondeado hacia arriba a $500, en los servicios que la piden (lo que eligió
// el dueño como valor por defecto, 2026-10-09).
//
// Las claves de rubro se guardan en config.json: no se renombran nunca.

const PLANTILLAS = {
  unas: {
    nombre: 'Uñas y belleza',
    textos: {
      emoji: '💅',
      cliente: 'clienta',
      clientes: 'clientas',
      cliente_mayuscula: 'Clienta',
      el_cliente: 'la clienta',
      cliente_nuevo: 'es clienta nueva. Tocá el archivo para guardarla en tu agenda.',
      algun_cliente: 'alguna clienta',
      ningun_cliente: 'ninguna clienta registrada',
      a_todos: 'a TODAS las clientas',
      todos: 'todas las clientas',
      quien_atiende: 'la dueña',
      ejemplo_servicio: 'kapping',
      ejemplo_precio: '30000',
    },
    servicios: [
      { id: 1, nombre: 'Semipermanente manos', duracion_min: 60, precio: 18000, sena: 0 },
      { id: 2, nombre: 'Esculpidas en polygel', duracion_min: 120, precio: 32000, sena: 10000, alias: ['esculpidas', 'polygel'] },
      { id: 3, nombre: 'Kapping rubber', duracion_min: 75, precio: 22000, sena: 0, alias: ['kapping'] },
      { id: 4, nombre: 'Retiro', duracion_min: 20, precio: 6000, sena: 0 },
      { id: 5, nombre: 'Semipermanente pies', duracion_min: 60, precio: 20000, sena: 0 },
      { id: 6, nombre: 'Perfilado + tinte de cejas', duracion_min: 30, precio: 9000, sena: 0, alias: ['cejas'] },
      { id: 7, nombre: 'Lifting de pestañas', duracion_min: 60, precio: 25000, sena: 7500, alias: ['lifting'] },
    ],
  },

  barberia: {
    nombre: 'Barbería',
    textos: {
      emoji: '💈',
      cliente: 'cliente',
      clientes: 'clientes',
      cliente_mayuscula: 'Cliente',
      el_cliente: 'el cliente',
      cliente_nuevo: 'es cliente nuevo. Tocá el archivo para guardarlo en tu agenda.',
      algun_cliente: 'algún cliente',
      ningun_cliente: 'ningún cliente registrado',
      a_todos: 'a TODOS los clientes',
      todos: 'todos los clientes',
      quien_atiende: 'el barbero',
      ejemplo_servicio: 'corte',
      ejemplo_precio: '13000',
    },
    servicios: [
      { id: 1, nombre: 'Corte clásico', duracion_min: 30, precio: 12000, sena: 0, alias: ['corte'] },
      { id: 2, nombre: 'Fade / degradé', duracion_min: 45, precio: 14000, sena: 0, alias: ['fade', 'degrade'] },
      { id: 3, nombre: 'Corte + barba', duracion_min: 60, precio: 17000, sena: 5500 },
      { id: 4, nombre: 'Perfilado de barba', duracion_min: 30, precio: 7000, sena: 0 },
      { id: 5, nombre: 'Afeitado con navaja', duracion_min: 30, precio: 9000, sena: 0, alias: ['afeitado'] },
      { id: 6, nombre: 'Platinado', duracion_min: 120, precio: 38000, sena: 11500 },
    ],
  },
};

// Nombres viejos que ya pueden estar en un config.json instalado.
const ALIAS = { salon_de_unas: 'unas' };

function claveDeRubro(rubro) {
  return ALIAS[rubro] || rubro;
}

function plantillaDe(rubro) {
  return PLANTILLAS[claveDeRubro(rubro)] || null;
}

// "le aviso a la dueña", "le aviso al barbero", "le aviso a Nico": el texto
// "quien_atiende" lo puede cambiar cada negocio, así que la contracción se arma
// acá y no se escribe en la plantilla.
function aQuienAtiende(textos) {
  const quien = textos.quien_atiende;
  return /^el /i.test(quien) ? `al ${quien.slice(3)}` : `a ${quien}`;
}

// Los servicios de ejemplo con la forma que pide config.json.
function serviciosDe(rubro) {
  const p = plantillaDe(rubro);
  return p ? p.servicios.map((s) => ({ ...s, catalogo_id: '' })) : [];
}

module.exports = { PLANTILLAS, plantillaDe, claveDeRubro, serviciosDe, aQuienAtiende };
