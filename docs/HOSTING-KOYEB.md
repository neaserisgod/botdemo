# Hosting gratis: Koyeb (free) + pings de UptimeRobot

Análisis y plan técnico para correr el bot (adaptador Baileys) como **Web Service** en la instancia gratuita de Koyeb,
con pings HTTP periódicos para que el contenedor no se duerma.

> Estado: **plan, no implementado**. Los datos de Koyeb/UptimeRobot se verificaron en octubre 2026; revisarlos antes
> de ejecutar (Koyeb está pasando a Mistral Compute desde febrero 2026 y su capa gratis puede cambiar).

---

## 0. Veredicto corto

La idea **anda** para el problema que ataca (el *scale-to-zero*), pero sola **no alcanza**. Hay dos cosas que la rompen
si no se resuelven antes:

| # | Problema | Gravedad | Por qué |
|---|----------|----------|---------|
| 1 | **El disco de la instancia free es efímero y no admite Volumes** | 🔴 Bloqueante | `data/sesion-baileys/` (la vinculación de WhatsApp) y `data/bot.db` (los turnos) se pierden en cada redeploy, reinicio o reubicación del contenedor. Resultado: hay que volver a vincular el número y se pierden los turnos. Es lo **opuesto** a "cero fricción". |
| 2 | **El panel quedaría público en internet** | 🔴 Seguridad | `src/panel/server.js` expone `/` (eventos, turnos del día), `/calendario.ics` (todos los turnos con nombres) y `POST /reiniciar` **sin autenticación**. Hoy es seguro porque escucha en `127.0.0.1`; en Koyeb tiene que escuchar en `0.0.0.0`. |
| 3 | UptimeRobot free es **solo para uso no comercial** desde fines de 2024 | 🟠 Legal/cuenta | bot-turnos es un producto comercial: riesgo de que suspendan la cuenta. Hay alternativas gratis sin esa restricción (ver §5). |
| 4 | 0,1 vCPU | 🟡 Rendimiento | Alcanza para Baileys + SQLite con poco tráfico; el OCR con tesseract (comprobantes) va a ser lento o no va a estar instalado. |

Con 1 y 2 resueltos, el esquema es viable.

---

## 1. Restricciones de la plataforma (lo que condiciona el diseño)

**Koyeb Free Instance**
- 512 MB RAM · 0,1 vCPU · 2 GB SSD **efímero** · 1 instancia gratis por organización.
- Solo regiones Frankfurt (`fra`) o Washington (`was`). Para Argentina, `was` tiene menos latencia.
- Solo **Web Service** (no Worker): tiene que escuchar HTTP en un puerto, y Koyeb le hace health check.
- **Sin Volumes** (no hay disco persistente).
- **Scale-to-zero tras 1 h sin tráfico HTTP entrante**, no desactivable en el plan free. La conexión saliente de
  Baileys (WebSocket a WhatsApp) **no cuenta** como tráfico: por eso hacen falta los pings.
- Puede pedir tarjeta de crédito al registrarse (pre-autorización que después se cancela).

**Implicancia clave:** el bot mantiene estado de larga vida (sesión Signal de WhatsApp + base de turnos). En una
plataforma *stateless* ese estado tiene que vivir **fuera** del contenedor.

**Memoria (512 MB):** Node + Baileys en reposo usa ~120–200 MB. Sobra margen si:
- no se instala `whatsapp-web.js` (arrastra Chromium) → `npm ci --omit=optional`;
- `syncFullHistory: false` (ya está así en `src/adaptadores/baileys.js`);
- se limita el heap: `NODE_OPTIONS=--max-old-space-size=384`.

---

## 2. Arquitectura propuesta

```
              cada 5 min (GET /vivo)
 Monitor  ─────────────────────────────►  Koyeb edge (HTTPS)
 externo                                       │
                                               ▼
                                 ┌──────── contenedor free (512 MB) ────────┐
                                 │  node src/index.js  (ADAPTADOR=baileys)  │
                                 │   ├─ HTTP :$PORT  /vivo  /salud  (panel) │
                                 │   ├─ Baileys ── WebSocket ──► WhatsApp   │
                                 │   └─ disco efímero: solo caché           │
                                 └───────────────┬──────────────────────────┘
                                                 │ sesión WA + turnos
                                                 ▼
                                   Almacenamiento persistente externo
                                   (Postgres gratis: Neon / Supabase,
                                    o libSQL: Turso)
```

Principios:
1. **El contenedor es descartable.** Si Koyeb lo mata y lo levanta en otra máquina, el bot vuelve solo, ya vinculado
   y con todos los turnos.
2. **Dos endpoints distintos:** uno de *vida del proceso* (para Koyeb y para el ping) y otro de *salud de WhatsApp*
   (para alertas).
3. **Nada privado expuesto sin token.**

---

## 3. Pasos técnicos

### Fase A — Persistencia fuera del contenedor (bloqueante)

**A1. Sesión de Baileys en una base externa.**
`useMultiFileAuthState(dirSesion)` escribe archivos en disco. Hay que reemplazarlo por un *auth state* propio con la
misma interfaz (`{ state: { creds, keys: { get, set } }, saveCreds }`) respaldado en Postgres/libSQL:

- Tabla `wa_auth(clave TEXT PRIMARY KEY, valor TEXT)`; `creds` en una fila, cada clave Signal (`pre-key-…`,
  `session-…`, `sender-key-…`, `app-state-sync-key-…`) en otra.
- Serializar con `BufferJSON.replacer` / `BufferJSON.reviver` de Baileys (las claves son `Buffer`).
- `keys.set` en **transacción** (Baileys escribe lotes) y seguir envolviendo con `makeCacheableSignalKeyStore`
  (ya está): evita el "Bad MAC" por escrituras concurrentes.
- Elegir con una variable: `SESION_EN=archivos|postgres` (default `archivos` para no romper el celu con Termux).

**A2. Turnos y eventos fuera del contenedor.** Dos caminos:

| Opción | Esfuerzo | Notas |
|--------|----------|-------|
| **libSQL/Turso** (SQLite remoto, free) | Bajo | Mismo dialecto SQL que `src/db/esquema.sql`. Pero el cliente es **asíncrono** y hoy `src/db` es síncrono (`prepare().run()`): hay que volver async las consultas y sus llamadores. |
| **Réplica embebida de libSQL** (`file:` local + sync al remoto) | Medio | Lecturas síncronas locales, sync periódico. Si el contenedor muere entre syncs, se pierden los últimos segundos. |
| Backup/restore de `bot.db` a un bucket (S3/R2) al arrancar y cada N min | Bajo | El más simple, pero ventana de pérdida = intervalo del backup. Aceptable como paso intermedio. |

Recomendación: **arrancar con backup/restore** (rápido de hacer, `scripts/backup.sh` ya existe como base) y migrar a
libSQL si el producto se queda en la nube.

Los demás archivos de `data/` (`lid-map.json`, `comprobantes/`, `calendario/`, `contactos/`) son reconstruibles o
temporales; `lid-map.json` conviene guardarlo en la misma tabla clave/valor de A1.

**A3. Lock de instancia única.** `tomarLock()` usa `data/bot.pid`, que en un contenedor siempre arranca vacío: no
protege de nada. En Koyeb el riesgo real es **durante un redeploy**, donde la instancia vieja y la nueva conviven unos
segundos y pelean por la misma sesión. Mitigación: lock en la base (`wa_auth` con fila `lock` + timestamp de
heartbeat) y que la instancia nueva espere a que la vieja suelte.

### Fase B — Adaptar el proceso a Koyeb

**B1. Puerto y host.** Koyeb inyecta `PORT`. En `src/panel/server.js`:
`puerto = process.env.PORT || config.panel.puerto`, `host = process.env.PORT ? '0.0.0.0' : (lo de hoy)`.

**B2. Endpoints.**
- `GET /vivo` → siempre `200 ok` si el proceso responde. Lo usan el health check de Koyeb y el ping. **No** depende de
  WhatsApp: si dependiera, Koyeb mataría el contenedor durante una reconexión normal o mientras se vincula.
- `GET /salud` → `200` si `conectado`, `503` si no. Lo usa el monitor para **alertar** (keyword/status monitor).
  Hoy devuelve siempre 200 con `{ conectado }`.

**B3. Proteger el resto.** Middleware que exija `PANEL_TOKEN` (header `Authorization: Bearer` o `?token=`) para `/`,
`/calendario.ics` y `/reiniciar`. Sin `PANEL_TOKEN` definido y escuchando en `0.0.0.0` → no montar esas rutas.
`/reiniciar` con `pm2 restart` no aplica en Koyeb: reemplazar por `process.exit(1)` (Koyeb lo relanza).

**B4. Apagado prolijo.** Koyeb manda `SIGTERM` en cada redeploy. Hoy el handler sale enseguida; tiene que hacer
`adaptador.cerrar()`, esperar a que `saveCreds` termine y soltar el lock, y recién ahí salir (con timeout de ~10 s).

**B5. Dockerfile** (más control que el buildpack: Node fijo, sin opcionales):

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=optional --omit=dev && npm cache clean --force
COPY . .
ENV NODE_ENV=production ADAPTADOR=baileys NODE_OPTIONS=--max-old-space-size=384
CMD ["node", "src/index.js"]
```

Node 22.5+ porque sin `better-sqlite3` el bot usa `node:sqlite` (ver `src/db/motor.js`). Agregar `.dockerignore` con
`node_modules`, `data`, `logs`, `config.json`, `config.local.json`.

**B6. Configuración por variables.** `config.json` no está en el repo (bien). En Koyeb hay tres opciones, de mejor a
peor: (a) vincular a **Nodo Sur** (el bot ya baja la config de ahí), (b) un secreto `CONFIG_JSON` que `src/config.js`
lea como capa extra, (c) commitear un config → **no**, tiene datos del cliente.

### Fase C — Vinculación de WhatsApp sin terminal

En Koyeb no hay pantalla para escanear el QR. El adaptador ya soporta **código de vinculación** con la variable
`PAREO=1`:
1. Primer deploy con `PAREO=1` y `numero_actual` configurado.
2. Ver el código en **Koyeb → Service → Logs** y cargarlo en el celular: WhatsApp → Dispositivos vinculados →
   Vincular con número de teléfono.
3. Con la Fase A hecha, la sesión queda en la base: quitar `PAREO` y redeployar. No se vuelve a vincular nunca más
   (salvo que se cierre la sesión desde el teléfono).

Ojo: con `--pareo` por argumento el proceso sale a los 60 s; con `PAREO` por variable no sale. Verificar que en
Koyeb se use la variable, o Koyeb lo va a ver como crash.

### Fase D — Deploy en Koyeb

1. Crear cuenta → **Create Web Service** → GitHub → `neaserisgod/botdemo`, builder **Dockerfile**.
2. Instance: **Free**. Region: `was`.
3. Ports: `8000` HTTP, ruta `/` pública. Health check: **HTTP `GET /vivo`**, grace period ~60 s.
4. Variables/Secrets: `PORT=8000`, `ADAPTADOR=baileys`, `PANEL_TOKEN`, `DATABASE_URL` (o credenciales del bucket),
   `CONFIG_JSON` si no se usa Nodo Sur, `PAREO=1` solo para el primer deploy.
5. Autoscaling: min = max = 1 (nunca dos instancias con la misma sesión).
6. Desactivar el auto-deploy en cada push a `main`, o al menos tener resuelta la B4/A3: cada redeploy es una
   reconexión de WhatsApp.

### Fase E — Pings anti-sueño + alertas

- **Monitor 1 (keep-alive):** HTTP(s) `GET https://<app>.koyeb.app/vivo` cada **5 min**. Cualquier intervalo
  menor a 60 min evita el sueño; 5 min es el mínimo del plan free y además detecta caídas rápido.
- **Monitor 2 (salud real):** `GET /salud`, alerta si ≠ 200 durante 2 chequeos seguidos → aviso por email/Telegram.
  Esto complementa el watchdog de `baileys.js` y el `latido` diario que ya existen.

**Sobre UptimeRobot:** su plan free es **solo para uso no comercial** desde fines de 2024. Para un producto comercial
conviene una alternativa sin esa restricción:
- **cron-job.org** (gratis, intervalos de 1 min, alertas por mail);
- **GitHub Actions** con `schedule` (ojo: GitHub puede demorar o pausar crons en repos sin actividad);
- **Uptime Kuma** autohospedado (si ya hay otro servidor);
- **Auto-ping desde el propio bot** como red de seguridad: un `setInterval` que pide su URL pública cada 10 min.
  Atraviesa el edge de Koyeb, así que cuenta como tráfico. No reemplaza al monitor externo (si el proceso muere, no
  avisa a nadie), pero cubre los huecos.

---

## 4. Riesgos que quedan

- **Política de Koyeb:** mantener despierta una instancia free con pings está en una zona gris; el free tier puede
  cambiar (transición a Mistral). Tener el Dockerfile genérico permite mudarse a otro host en minutos.
- **Reubicaciones periódicas del contenedor:** con la Fase A son invisibles para el cliente (una reconexión de unos
  segundos); sin ella, cada una obliga a re-vincular.
- **Comprobantes con OCR:** tesseract no está en la imagen slim y con 0,1 vCPU sería lento. Desactivarlo en la nube o
  instalarlo (`apt-get install tesseract-ocr`, +~30 MB) y medir.
- **Riesgo de baneo de WhatsApp:** IPs de datacenter son más sospechosas que un celular hogareño. Baileys no es
  oficial; esto aplica a cualquier hosting en la nube, no solo a Koyeb.

---

## 5. Orden sugerido de trabajo

1. **B1–B3** (puerto, `/vivo`, `/salud` con 503, token en el panel) — chico, sin riesgo, sirve también en el celu.
2. **B5 + B6** (Dockerfile, `CONFIG_JSON`) — probar local: `docker run -m 512m --cpus 0.1 …`.
3. **A1** (sesión en Postgres) — el cambio más delicado; probar matando el contenedor y verificando que reconecta sin
   pedir vinculación.
4. **A2** (backup/restore de `bot.db`) + **A3/B4** (lock + apagado prolijo).
5. **C–E** (vincular, deploy, monitores).

**Criterio de "listo":** redeployar el servicio en Koyeb con el bot en uso y que (a) no pida volver a vincular,
(b) los turnos sigan ahí, (c) responda un mensaje dentro de los 10 s siguientes, y (d) tras 2 h sin mensajes siga
respondiendo al instante.
