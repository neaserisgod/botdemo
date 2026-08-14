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
