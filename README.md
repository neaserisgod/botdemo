# bot-turnos

Bot de WhatsApp para gestión de turnos, pensado para independientes y negocios chicos (barberías, uñas, estética, masajes). Corre local en un celu Android reacondicionado con Termux — sin VPS, sin dependencias pagas.

## Arquitectura

La lógica de negocio (`src/core/`) está totalmente desacoplada de WhatsApp. El núcleo recibe mensajes planos `{ de, texto, rutaImagen, productoId }` y devuelve salientes `{ para, texto, imagenRuta }`. Los adaptadores (`src/adaptadores/`) traducen desde/hacia la librería de turno:

| Adaptador | Uso | Estado |
|---|---|---|
| `whatsappweb` | Demo en PC (usa Chromium) | ✅ funcional |
| `consola` | Probar el flujo sin WhatsApp | ✅ funcional |
| `baileys` | Producción en el celu (sin Chromium) | 🔜 fase 2 |

```
src/
├── index.js            arranque: config + DB + adaptador + cron + panel
├── core/               núcleo (NO importa nada de WhatsApp)
│   ├── motor.js        puerta de entrada: rutea dueña / clienta
│   ├── maquina.js      máquina de estados de la conversación
│   ├── agenda.js       slots libres, sin solapamientos
│   ├── duena.js        !hoy !semana !turno !ok !no !anular !precio
│   ├── recordatorios.js  24 hs antes + catch-up al reiniciar + señas vencidas
│   ├── notificaciones.js mensajes hacia la dueña
│   ├── ocr.js          tesseract nativo (Termux) con fallback a caption
│   └── flujos/         faq.js, senas.js
├── adaptadores/        whatsappweb / consola / baileys
├── db/                 esquema.sql + consultas (better-sqlite3)
├── panel/              Express en localhost: estado, uptime, reiniciar
└── salud/              conectividad, batería (Termux:API), latido diario
```

## Máquina de estados (clienta)

```
inicio ──1──► eligiendo_servicio ──► eligiendo_dia ──► eligiendo_hora
  │                                                        │
  ├─ FAQ (precios/ubicación/horarios) responde y queda     ├─ sin nombre → pidiendo_nombre
  ├─ "cancelar" → cancelando                               ▼
  ├─ "confirmo" → marca respuesta del recordatorio     confirmando
  └─ 2 "no entendí" seguidos → derivación a humano    ┌────┴────────┐
     (bot calla 12 hs, dueña atiende a mano)     con seña        sin seña
                                            esperando_comprobante  confirmado
                                             │ foto → OCR → verificado / a_revisar
                                             └ 2 hs sin foto → vencido (libera slot)
```

El estado vive en la DB (`clientas.estado_conv` + `datos_conv` JSON): sobrevive reinicios.

## Correr la demo

```bash
npm install
npm run consola     # probar el flujo completo sin WhatsApp
npm run demo        # con WhatsApp real (whatsapp-web.js, escanear QR)
```

En modo consola: `/soy <numero>` para cambiar de remitente (el número de `numero_duena` en config.json habilita los comandos `!`), `/foto <texto>` simula un comprobante (el texto hace de OCR), `/producto <id>` simula tocar un ítem del catálogo.

## Configurar un cliente nuevo

1. Copiar `config.example.json` → `config.json` y completar: nombre, dirección, horarios, servicios (precio, duración, seña), `numero_duena`, alias y titular de MP.
2. En el celu: `bash setup.sh <url-repo>` (ver comentarios del script).
3. Escanear QR, listo.

**Migración de número:** borrar `data/sesion*`, reiniciar, escanear QR con el chip nuevo, y avisar a las clientas desde la DB (`clientas.telefono`).

## Señas (flujo)

1. Turno queda `pendiente_sena`; clienta recibe alias + monto + plazo de 2 hs.
2. Manda foto → OCR (binario `tesseract` en Termux; en PC usa el caption como fallback) → regex extrae monto / destinatario / nº operación / fecha.
3. Todo cierra → `verificado`, turno confirmado, dueña recibe foto + datos.
4. Algo no cierra (monto corto, destinatario raro, operación duplicada — UNIQUE en DB) → `a_revisar`, la dueña resuelve con `!ok N` / `!no N`.
5. 2 hs sin comprobante → `vencido`, slot liberado, avisa a ambas.

## Notas de producción (fase 2)

- Migrar a Baileys (`src/adaptadores/baileys.js` tiene las notas).
- `pm2 startup` no existe en Termux: se usa Termux:Boot + `pm2 resurrect` (lo deja armado `setup.sh`).
- Backup diario: `scripts/backup.sh` (necesita `rclone config` una vez).
- Panel: `http://localhost:3010` en el celu; remoto vía Tailscale + SSH.
