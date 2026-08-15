# bot-turnos

Bot de WhatsApp para gestión de turnos: independientes y negocios chicos (barberías, uñas, estética, masajes). Corre local en un celu Android reacondicionado con Termux — sin VPS, sin servicios pagos.

## Arrancar (3 comandos)

```bash
git clone <este-repo> bot-turnos
cd bot-turnos && npm install
npm run baileys
```

Escaneás el QR (o usás código, ver abajo) y ya está funcionando. `config.json` viene en el repo con una configuración lista; para un cliente nuevo lo editás y listo.

> ⚠️ El repo incluye `config.json` con el número de la dueña: **mantenelo privado**.

### Comandos

| Comando | Para qué |
|---|---|
| `npm run baileys` | Producción y pruebas reales (sin Chromium, anda en el celu) |
| `npm run consola` | Probar el flujo entero sin WhatsApp |
| `npm run demo` | whatsapp-web.js (alternativa en PC, usa Chromium) |
| `npm test` | Las 3 suites de tests (167 chequeos) |

En modo consola: `/soy <numero>` cambia de remitente (usá el `numero_duena` del config para probar los comandos `!`), `/foto <texto>` simula un comprobante, `/producto <id>` simula el catálogo.

## Configuración

Todo se maneja desde `config.json`. Al arrancar se valida y, si algo está mal, el bot lo dice en castellano y no arranca (número sin `549`, seña mayor al precio, horario invertido, día faltante, etc.).

Lo que se toca por cliente: `negocio`, `numero_duena` (recibe avisos y comandos), `numero_soporte` (tuyo, recibe el latido diario), `numero_actual` (el chip del bot), `horarios`, `servicios` (duración, precio, seña) y `senas` (alias y titular de MP).

## Cómo está armado

> 📖 Para el detalle completo (arquitectura, decisiones técnicas, cómo viaja un mensaje por dentro, qué pasa ante cada falla) está **[docs/COMO-FUNCIONA.md](docs/COMO-FUNCIONA.md)**.

La lógica de negocio (`src/core/`) no importa nada de WhatsApp: recibe `{ de, texto, rutaImagen, productoId }` y devuelve `{ para, texto, imagenRuta }`. Los adaptadores traducen.

```
src/
├── index.js            arranque: config + DB + adaptador + cron + panel
├── config.js           carga y valida config.json
├── core/               núcleo (sin dependencias de WhatsApp)
│   ├── motor.js        puerta de entrada: rutea dueña / clienta
│   ├── maquina.js      máquina de estados de la conversación
│   ├── nlu.js          intenciones + typos + fechas/horas en texto libre
│   ├── agenda.js       slots libres, sin solapamientos
│   ├── duena.js        comandos de la dueña (lenguaje natural + atajos !)
│   ├── nlu-duena.js    interpreta "anulá el 3", "qué tengo hoy", etc.
│   ├── recordatorios.js 24 hs antes, catch-up al reiniciar, señas vencidas
│   ├── ocr.js          tesseract nativo (spa → eng → caption)
│   ├── calendario.js   genera los .ics para el calendario de la dueña
│   ├── contactos.js    genera los .vcf para la agenda de la dueña
│   └── flujos/         faq.js, senas.js
├── adaptadores/        baileys (producción) / consola / whatsappweb
├── db/                 esquema.sql + consultas (better-sqlite3)
├── panel/              Express en localhost: estado, uptime, reiniciar
└── salud/              conectividad, batería, latido diario
```

### Máquina de estados

```
inicio ──► eligiendo_servicio ──► eligiendo_dia ──► eligiendo_hora
  │                                                      │
  ├─ FAQ (precios/ubicación/horarios), tolera typos      ├─ sin nombre → pidiendo_nombre
  ├─ "no voy a poder ir" → cancelando                    ▼
  ├─ "confirmo" → responde el recordatorio           confirmando
  └─ 2 mensajes sin entender → deriva a humano      ┌────┴────────┐
     (calla 12 hs, la dueña atiende a mano)    con seña        sin seña
                                          esperando_comprobante  confirmado
                                           │ foto → OCR → verificado / a_revisar
                                           └ 2 hs sin foto → vencido (libera el slot)
```

El estado vive en la DB, así que sobrevive reinicios. El lenguaje natural es diccionario puro (sin IA): "hola quería reservar kapping para mañana a las 11" salta directo a pedir el nombre.

## Instalación en el celu (Termux)

1. Chip en el celu, instalar **WhatsApp Business** y registrar el número (ahí también cargás el catálogo).
2. Desde f-droid.org: **Termux**, **Termux:Boot** y **Termux:API** (no las de Play Store). Abrir Termux:Boot una vez.
3. En Termux:
   ```bash
   pkg install -y git
   git clone <este-repo> ~/bot-turnos
   cd ~/bot-turnos && bash setup.sh
   ```
   El script instala todo y, cuando llega a la vinculación, te muestra un **código de 8 caracteres** (el QR no sirve: WhatsApp está en el mismo celu). Lo metés en WhatsApp > Dispositivos vinculados > **Vincular con el número de teléfono**. Apenas conecta, el script arranca el bot con PM2 y queda andando.
4. Para otro cliente: editar `config.json` (`nano config.json`) y `pm2 restart bot-turnos`.
5. Android > Apps > Termux > Batería > **Sin restricciones** (ídem Termux:Boot). Reiniciar el celu y verificar con `pm2 logs bot-turnos`.

**Migración de número:** borrar `data/sesion-baileys/`, reiniciar, vincular el chip nuevo, avisar a las clientas desde la DB.

## Señas

1. Turno queda `pendiente_sena`; la clienta recibe alias, monto y plazo.
2. Manda la foto → OCR (Tesseract nativo, español) → regex saca monto, destinatario, nº de operación y fecha.
3. Todo cierra → `verificado`, turno confirmado, la dueña recibe la foto con los datos.
4. Algo no cierra (monto corto, destinatario ajeno, operación repetida — `UNIQUE` en la DB) → `a_revisar`; la dueña resuelve diciendo _"aprobá la 7"_ o _"rechazá la 7"_ (o con `!ok 7` / `!no 7`).
5. Sin comprobante en 2 hs → `vencido`, el horario se libera y avisa a las dos.

Nunca se pierde una seña: lo que el OCR no entiende va a revisión manual, no se descarta.

## Tests

`npm test` corre tres suites (167 chequeos): flujo completo, escenarios hostiles (señas falsas, carreras por el mismo horario, comandos mal usados, fuzzing) y límites (bordes de agenda, persistencia, configuración cambiada a mitad de flujo).

## Operación

- Panel: `http://localhost:3010` en el celu (estado, uptime, últimos eventos, reiniciar).
- Soporte remoto: Tailscale + SSH.
- Motor de base: better-sqlite3 en PC, SQLite incorporado de Node en el celu (`src/db/motor.js`).
- Backup: `scripts/backup.sh` (requiere `rclone config` una vez).
- Latido diario al `numero_soporte`: solo salud del sistema, nunca datos de clientas.
