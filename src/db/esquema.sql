-- Esquema de bot-turnos. Fechas en texto ISO local (YYYY-MM-DD HH:MM), zona del negocio.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Clientas: una fila por número de WhatsApp. El estado conversacional vive acá
-- para sobrevivir reinicios del bot (estado + datos parciales en JSON).
CREATE TABLE IF NOT EXISTS clientas (
  id                 INTEGER PRIMARY KEY,
  telefono           TEXT NOT NULL UNIQUE,      -- ej: 5492944XXXXXX (sin @c.us)
  nombre             TEXT,
  estado_conv        TEXT NOT NULL DEFAULT 'inicio',
  datos_conv         TEXT NOT NULL DEFAULT '{}', -- JSON: selección parcial (servicio, día, hora)
  no_entendidos      INTEGER NOT NULL DEFAULT 0, -- seguidos; a 2 se deriva a humano
  derivada_hasta     TEXT,                       -- si está derivada, el bot calla hasta esta fecha
  creada_en          TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  ultima_interaccion TEXT
);

-- Servicios: espejo de config.json, sembrado al arrancar. La DB es la fuente
-- de verdad de precios en runtime; config.json es la semilla editable.
CREATE TABLE IF NOT EXISTS servicios (
  id           INTEGER PRIMARY KEY,
  nombre       TEXT NOT NULL,
  duracion_min INTEGER NOT NULL,
  precio       INTEGER NOT NULL,
  sena         INTEGER NOT NULL DEFAULT 0,      -- 0 = sin seña, confirma directo
  catalogo_id  TEXT NOT NULL DEFAULT '',        -- id del ítem en el catálogo de WhatsApp Business
  alias        TEXT NOT NULL DEFAULT '',        -- otros nombres, separados por coma ("fade,degrade")
  activo       INTEGER NOT NULL DEFAULT 1
);

-- Turnos. inicio/fin precalculados para chequear solapamientos con un BETWEEN.
CREATE TABLE IF NOT EXISTS turnos (
  id                    INTEGER PRIMARY KEY,
  clienta_id            INTEGER NOT NULL REFERENCES clientas(id),
  servicio_id           INTEGER NOT NULL REFERENCES servicios(id),
  inicio                TEXT NOT NULL,           -- YYYY-MM-DD HH:MM
  fin                   TEXT NOT NULL,
  estado                TEXT NOT NULL DEFAULT 'pendiente_sena',
    -- pendiente_sena → confirmado → completado
    --                → cancelado (clienta) | anulado (dueña) | vencido (seña no llegó)
  recordatorio_enviado  INTEGER NOT NULL DEFAULT 0,
  recordatorio_respuesta TEXT,                   -- 'confirmo' | 'cancelo' | null
  creado_en             TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_turnos_inicio ON turnos(inicio);
CREATE INDEX IF NOT EXISTS idx_turnos_estado ON turnos(estado);

-- Señas por transferencia. nro_operacion UNIQUE frena comprobantes repetidos.
CREATE TABLE IF NOT EXISTS senas (
  id                     INTEGER PRIMARY KEY,
  turno_id               INTEGER NOT NULL REFERENCES turnos(id),
  estado                 TEXT NOT NULL DEFAULT 'esperando_comprobante',
    -- esperando_comprobante → verificado | a_revisar | vencido
    -- a_revisar → verificado (!ok) | rechazada (!no)
  monto_esperado         INTEGER NOT NULL,
  monto_detectado        INTEGER,
  destinatario_detectado TEXT,
  nro_operacion          TEXT UNIQUE,            -- UNIQUE: anti comprobante duplicado
  fecha_detectada        TEXT,
  ruta_imagen            TEXT,
  ocr_texto              TEXT,                   -- texto crudo del OCR, para auditar
  motivo_revision        TEXT,                   -- por qué quedó a_revisar
  vence_en               TEXT NOT NULL,          -- creada + vencimiento_horas
  creada_en              TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  resuelta_en            TEXT,
  resuelta_por           TEXT                    -- 'ocr' | 'duena'
);
CREATE INDEX IF NOT EXISTS idx_senas_estado ON senas(estado);

-- Eventos de conectividad y salud del sistema.
CREATE TABLE IF NOT EXISTS eventos_conectividad (
  id        INTEGER PRIMARY KEY,
  tipo      TEXT NOT NULL,   -- arranque | caida | reconexion | bateria | latido
  detalle   TEXT,
  creado_en TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- Pedidos de un comercio (forma productos): la bandeja de salida hacia Nodo Sur. El pedido se guarda acá apenas el
-- cliente lo confirma, así no se pierde si no hay internet; `nube/sincronizar.js` lo manda (reintentar con el mismo
-- pedido_id no lo duplica en el sitio) y, cuando el local lo acepta o rechaza en la app, el bot le avisa al cliente.
CREATE TABLE IF NOT EXISTS pedidos (
  id             INTEGER PRIMARY KEY,
  pedido_id      TEXT NOT NULL UNIQUE,          -- el id que viaja a Nodo Sur
  clienta_id     INTEGER NOT NULL REFERENCES clientas(id),
  datos          TEXT NOT NULL,                 -- JSON: { cliente: {nombre, telefono}, items: [...], nota? }
  estado         TEXT NOT NULL DEFAULT 'por_enviar',
    -- por_enviar → enviado → aceptado | rechazado;  por_enviar → a_mano (Nodo Sur no aceptó los gramos: fue por WhatsApp)
  remoto_id      INTEGER,                       -- el id del pedido en Nodo Sur
  avisado        INTEGER NOT NULL DEFAULT 0,    -- 1 cuando el cliente ya recibió si se aceptó o no
  creado_en      TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
  actualizado_en TEXT
);
CREATE INDEX IF NOT EXISTS idx_pedidos_estado ON pedidos(estado);

-- Lo que el bot no entendió (cayó al menú sin ser un saludo, "no encontré", "no te entendí"). Es lo que alimenta el
-- diccionario (src/core/diccionario/): la dueña lo ve con "qué no entendiste" y cada frase se suma a test/frases.js.
-- Se guardan las últimas 500.
CREATE TABLE IF NOT EXISTS no_entendidos (
  id         INTEGER PRIMARY KEY,
  telefono   TEXT NOT NULL,
  texto      TEXT NOT NULL,
  estado     TEXT,                                  -- en qué paso de la charla estaba
  creado_en  TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
