// Lo que se dice en cada rubro. Dos clases de diccionario:
//
//  * servicios (negocios con turnos): cómo se pide cada cosa → las palabras que aparecen en el NOMBRE del servicio.
//    "manicura" → "semipermanente manos": así encuentra "Semipermanente manos" aunque el negocio lo haya cargado con otro
//    nombre parecido, y "semi" → "semipermanente" deja elegir entre manos y pies. Sirve con los servicios de cualquier
//    config, no solo con los de ejemplo: lo que importa es la palabra, no el id.
//
//  * productos (comercios): una palabra del cliente → otras que pueden estar en el nombre del producto del catálogo de
//    Nodo Sur ("birra" → cerveza; "gaseosa" → coca, sprite, fanta…). Alcanza con que calce una.
//
// Claves y valores escritos como quedan después de `nlu.normalizar` (sin tildes, "ñ" como "n": "pestanas").

const SERVICIOS = {
  unas: {
    semi: 'semipermanente', esmaltado: 'semipermanente', 'esmaltado semipermanente': 'semipermanente',
    manicura: 'semipermanente manos', manicuria: 'semipermanente manos', manicure: 'semipermanente manos', mani: 'semipermanente manos',
    pedicura: 'semipermanente pies', pedicuria: 'semipermanente pies', pedicure: 'semipermanente pies', pedi: 'semipermanente pies',
    'unas de los pies': 'pies', 'de los pies': 'pies', 'de las manos': 'manos',
    acrilicas: 'esculpidas', acrilica: 'esculpidas', acrilico: 'esculpidas', acrilicos: 'esculpidas', esculpida: 'esculpidas',
    esculpir: 'esculpidas', 'unas largas': 'esculpidas', 'gel esculpido': 'esculpidas',
    capping: 'kapping', kaping: 'kapping', caping: 'kapping', kapin: 'kapping', rubber: 'kapping', 'base rubber': 'kapping',
    'sacar el esmalte': 'retiro', 'sacas el esmalte': 'retiro', 'sacarme el esmalte': 'retiro', 'sacar las unas': 'retiro',
    'sacarme las unas': 'retiro', 'sacar el semi': 'retiro', 'sacarme el semi': 'retiro', retirar: 'retiro', retirarme: 'retiro',
    'perfilar las cejas': 'cejas', 'depilar las cejas': 'cejas', 'depilacion de cejas': 'cejas', 'perfilado de cejas': 'cejas',
    pestanas: 'lifting pestanas', laminado: 'lifting pestanas', 'lifting de pestanas': 'lifting pestanas',
  },
  barberia: {
    pelo: 'corte', cabello: 'corte', cortarme: 'corte', cortar: 'corte', 'corte de pelo': 'corte', recorte: 'corte',
    rebaje: 'corte', rebajar: 'corte', rapado: 'corte', rapar: 'corte', rapas: 'corte', rapame: 'corte', raparme: 'corte',
    maquina: 'corte', pelado: 'corte', nene: 'corte', nino: 'corte', pibe: 'corte', 'cortecito': 'corte',
    degradado: 'fade', degrade: 'fade', desvanecido: 'fade', taper: 'fade', 'low fade': 'fade', 'mid fade': 'fade',
    afeitar: 'afeitado', afeitada: 'afeitado', afeitarme: 'afeitado', navaja: 'afeitado', rasurar: 'afeitado',
    perfilar: 'perfilado', perfilas: 'perfilado', perfilame: 'perfilado', perfilarme: 'perfilado',
    'arreglar la barba': 'perfilado barba', 'arreglo de barba': 'perfilado barba', 'arreglarme la barba': 'perfilado barba',
    mechitas: 'platinado', mechas: 'platinado', reflejos: 'platinado', decoloracion: 'platinado', decolorar: 'platinado',
    decolorado: 'platinado', platinar: 'platinado', rubio: 'platinado', tenir: 'platinado', tintura: 'platinado',
  },
};

// Para todos los comercios (almacén, kiosco, fiambrería, otro): un almacén también vende puchos y un kiosco gaseosas.
const PRODUCTOS_COMERCIO = {
  birra: ['cerveza'], birras: ['cerveza'], chela: ['cerveza'], porron: ['cerveza'], lata: ['lata', 'cerveza'],
  gaseosa: ['coca', 'sprite', 'fanta', 'pepsi', 'seven', 'manaos', 'cunnington', 'paso', 'schweppes', 'mirinda', 'gaseosa'],
  gaseosas: ['coca', 'sprite', 'fanta', 'pepsi', 'seven', 'manaos', 'cunnington', 'paso', 'schweppes', 'mirinda', 'gaseosa'],
  cocacola: ['coca'], cocucha: ['coca'], '7up': ['seven'], sevenup: ['seven'],
  puchos: ['cigarrillos', 'cigarrillo'], pucho: ['cigarrillos', 'cigarrillo'], cigarros: ['cigarrillos', 'cigarrillo'],
  cigarro: ['cigarrillos', 'cigarrillo'], faso: ['cigarrillos'], fasos: ['cigarrillos'],
  galletas: ['galletitas', 'galletas'], galleta: ['galletitas', 'galletas'], galletita: ['galletitas'],
  yogurt: ['yogur', 'yogurt'], yogur: ['yogur', 'yogurt'],
  fideos: ['fideos', 'tallarines', 'spaghetti', 'tirabuzon', 'mostachol', 'mono'], tallarines: ['tallarines', 'fideos'],
  soda: ['soda', 'sifon'], sifon: ['sifon', 'soda'],
  lavandina: ['lavandina', 'ayudin'], detergente: ['detergente', 'lavavajilla'],
  choco: ['chocolate'], chocolate: ['chocolate', 'chocolatada'], pancito: ['pan'], pancitos: ['pan'],
  chicle: ['chicle', 'beldent', 'topline'], chicles: ['chicle', 'beldent', 'topline'],
  alfa: ['alfajor'], papas: ['papas', 'lays', 'pringles'], fiambre: ['jamon', 'salame', 'mortadela', 'paleta', 'bondiola', 'salchichon'],
  azucar: ['azucar'], harina: ['harina'], aceite: ['aceite'], vino: ['vino'], tinto: ['tinto', 'vino'],
};

const PRODUCTOS = {
  kiosco: { atado: ['cigarrillos'], caramelos: ['caramelo', 'caramelos', 'sugus', 'flynn'], turron: ['turron'] },
  fiambreria: {
    cocido: ['cocido'], crudo: ['crudo'], salamin: ['salamin', 'salame'], picada: ['salame', 'queso', 'jamon', 'aceitunas'],
    'queso de maquina': ['maquina'], muzza: ['mozzarella', 'muzzarella'], mozzarella: ['mozzarella', 'muzzarella'],
  },
};

const serviciosDe = (rubro) => SERVICIOS[rubro] || {};
const productosDe = (rubro) => ({ ...PRODUCTOS_COMERCIO, ...(PRODUCTOS[rubro] || {}) });

module.exports = { SERVICIOS, PRODUCTOS_COMERCIO, PRODUCTOS, serviciosDe, productosDe };
