# bot-turnos

Bot de WhatsApp para negocios chicos. Según el rubro: **turnos** (barberías, uñas: agenda, seña, recordatorio) o **comercio** (almacén, kiosco, fiambrería: precio y si hay, sacados de Nodo Sur, y pedidos para retirar en el local). Corre en un celu Android con Termux — sin VPS, sin servicios pagos. Se puede vincular a [Nodo Sur](https://horsepos.com) para configurarlo desde la app y que los pedidos lleguen a Encargues.

## Instalar en el celu, con un comando

1. Desde **f-droid.org** (no Play Store): **Termux**, **Termux:Boot** y **Termux:API**. Abrir Termux:Boot una vez.
2. En Termux, pegar:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/neaserisgod/botdemo/main/instalar.sh | bash
   ```
3. Contestar lo que pregunta:
   - **¿Vinculás el bot a Nodo Sur?** Abre el navegador: entrás con la cuenta de Google del negocio (dueño o encargado), elegís la sucursal y tocás "Vincular". Si el bot ya está configurado en la app, la configuración baja sola.
   - Si no, **rubro, nombre, dirección y los dos números** (el del WhatsApp que atiende y el tuyo, para los avisos), como los escribís siempre: `2944 123456`.
   - **El código de WhatsApp**: en el celular que tiene el WhatsApp del negocio, Dispositivos vinculados › Vincular con el número de teléfono, y escribís el código.
4. Android › Apps › Termux (y Termux:Boot) › Batería › **Sin restricciones**.

Listo: queda andando y arranca solo al prender el celu.

Para instalar una rama que todavía no está en `main` (el instalador también tiene que salir de esa rama):

```bash
curl -fsSL https://raw.githubusercontent.com/neaserisgod/botdemo/<rama>/instalar.sh | RAMA=<rama> bash
```

## Arrancar en una PC (para probar)

```bash
git clone <este-repo> bot-turnos
cd bot-turnos && npm install
node scripts/config-de-rubro.js barberia   # o: unas
npm run baileys
```

Escaneás el QR (o usás código, ver abajo) y ya está funcionando. `config.json` no está en el repo: lo arma el script con la plantilla del rubro y después se completa con los datos del negocio (ver "Rubros").

### Comandos

| Comando | Para qué |
|---|---|
| `npm run baileys` | Producción y pruebas reales (sin Chromium, anda en el celu) |
| `npm run consola` | Probar el flujo entero sin WhatsApp |
| `npm run demo` | whatsapp-web.js (alternativa en PC, usa Chromium) |
| `npm test` | Las 6 suites de tests (276 chequeos) |

En modo consola: `/soy <numero>` cambia de remitente (usá el `numero_duena` del config para probar los comandos `!`), `/foto <texto>` simula un comprobante, `/producto <id>` simula el catálogo.

## Configuración

Se arma en capas, de menor a mayor prioridad:

| Archivo | ¿En el repo? | Para qué |
|---|---|---|
| `config.example.json` | **sí** | Plantilla con todos los campos. Por acá llegan los valores por defecto de las funciones nuevas |
| `config.json` | **no** | Los datos de *este* cliente. Es el que se edita |
| `data/config-nube.json` | **no** | Lo que se configura desde la app de Nodo Sur (lo baja el bot solo). Gana sobre `config.json`, y queda guardado para andar sin internet |
| `config.local.json` | **no** | Ajustes finos, opcional |

Que los dos últimos estén fuera del repo es lo que hace que **`git pull` nunca choque ni pise la configuración de un equipo instalado**. Y que la base sea `config.example.json` es lo que hace que una config vieja no se rompa cuando el bot suma opciones: los campos que falten se toman de ahí.

En cada celu, entonces:

```bash
node scripts/config-de-rubro.js barberia   # solo la primera vez (o: unas). setup.sh lo pregunta solo
nano config.json                           # números, negocio, servicios, horarios
```

Al arrancar se valida el resultado y, si algo está mal, el bot lo dice en castellano y no arranca: rubro desconocido, número sin `549`, seña mayor al precio, horario invertido, día faltante.

## Rubros

Cada rubro tiene una plantilla en `src/plantillas.js`: cómo habla el bot y con qué servicios de ejemplo arranca un negocio nuevo. `negocio.rubro` en `config.json` elige cuál.

| | `unas` (Uñas y belleza) | `barberia` (Barbería) |
|---|---|---|
| Emoji | 💅 | 💈 |
| Quien recibe el turno | clienta / clientas | cliente / clientes |
| Quien atiende | la dueña | el barbero |
| Ejemplo para la dueña o el dueño | "el kapping ahora sale 30000" | "el corte ahora sale 13000" |
| Servicios de ejemplo | 7 (semipermanente, esculpidas, kapping, retiro, pies, cejas, lifting) | 6 (corte, fade, corte + barba, barba, afeitado, platinado) |

Los servicios de ejemplo son los del mock de servicios de Nodo Sur; la seña es el 30 % del precio (redondeado a $500) en los que la piden. Cada servicio puede tener `alias` (otros nombres: "un fade", "kapping") para que el bot lo encuentre aunque no se diga el nombre entero.

Cualquier texto de la plantilla se pisa en `config.json`, sección `textos`. Por ejemplo, para que diga el nombre de quien atiende:

```json
"textos": { "quien_atiende": "Nico" }
```

El bot arma solo "le aviso a Nico", "al barbero" o "a la dueña". `config.json` con `"rubro": "salon_de_unas"` (instalaciones viejas) sigue andando como `unas`.

### Comercios: `almacen`, `kiosco`, `fiambreria`, `otro`

Las mismas claves que el rubro de Nodo Sur. El bot no da turnos (`forma: productos`, `core/comercio.js`):

- **Precio y si hay**: busca en el catálogo que publica Nodo Sur (nombre, precio, si hay stock; nada de costos), con errores de tipeo y palabras a medias ("galle" → galletitas). Aclara que es el precio de hoy y que puede cambiar.
- **Ubicación y horarios**, de la configuración.
- **Pedidos para retirar en el local** (sin envío): de a un producto con su cantidad ("2 coca"); si hay varios parecidos, pregunta cuál; **sin stock no se agrega**. Al confirmar, el pedido queda en una bandeja local y se manda a Nodo Sur, donde entra "por confirmar" en Encargues. Cuando el local lo acepta o rechaza en la app, el bot le avisa al cliente.
- La dueña o el dueño puede mandar avisos a todos y pedir los contactos; los pedidos y los precios se manejan desde Nodo Sur.

### La pausa

`pausa_minutos` (1 hora por defecto): cuánto se calla el bot en un chat cuando no entiende, cuando le piden una persona, o cuando **contestás vos a mano** desde el WhatsApp del negocio (el bot lo detecta y no te pisa).

## Nodo Sur

Vincular el bot a la cuenta del negocio (`bash bot.sh vincular-nodosur`, o el instalador) guarda un token en `data/nodosur.json`. Desde ahí, `src/nube/`:

- baja la **configuración** que se carga en la app y la aplica **sin reiniciar** (si no sirve, sigue la anterior);
- baja el **catálogo** (comercios) y lo guarda para arrancar sin internet;
- manda los **pedidos** de la bandeja (reintentar no duplica) y avisa al cliente cuando se resuelven;
- escucha los **avisos en vivo** del sitio (si no puede, revisa cada 10 minutos) y avisa que está vivo (ping cada hora, que renueva el token).

Solo con un plan que incluya el bot. Sin vincular, el bot anda igual con su `config.json`.

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
│   ├── diccionario/    las palabras: chat, intenciones, rubros, cantidades y pesos
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

## Instalación en el celu (Termux), a mano

Lo mismo que hace el instalador de un comando (arriba), paso a paso:

1. Desde f-droid.org: **Termux**, **Termux:Boot** y **Termux:API** (no las de Play Store). Abrir Termux:Boot una vez.
2. En Termux:
   ```bash
   pkg install -y git
   git clone https://github.com/neaserisgod/botdemo ~/bot-turnos
   cd ~/bot-turnos && bash setup.sh
   ```
   El script instala todo, ofrece vincularlo a Nodo Sur, pregunta los datos del negocio si hacen falta y, cuando llega a WhatsApp, te muestra un **código de 8 caracteres** (el QR no sirve si WhatsApp está en el mismo celu). Lo metés en WhatsApp > Dispositivos vinculados > **Vincular con el número de teléfono**, en el celular que tiene el WhatsApp del negocio. Apenas conecta, el script arranca el bot con PM2 y queda andando.
3. Para cambiar la configuración: desde la app de Nodo Sur, o `nano config.json` y `bash bot.sh reiniciar`.
4. Android > Apps > Termux > Batería > **Sin restricciones** (ídem Termux:Boot). Reiniciar el celu y verificar con `pm2 logs bot-turnos`.

**Migración de número:** borrar `data/sesion-baileys/`, reiniciar, vincular el chip nuevo, avisar a las clientas desde la DB.

## Señas

1. Turno queda `pendiente_sena`; la clienta recibe alias, monto y plazo.
2. Manda la foto → OCR (Tesseract nativo, español) → regex saca monto, destinatario, nº de operación y fecha.
3. Todo cierra → `verificado`, turno confirmado, la dueña recibe la foto con los datos.
4. Algo no cierra (monto corto, destinatario ajeno, operación repetida — `UNIQUE` en la DB) → `a_revisar`; la dueña resuelve diciendo _"aprobá la 7"_ o _"rechazá la 7"_ (o con `!ok 7` / `!no 7`).
5. Sin comprobante en 2 hs → `vencido`, el horario se libera y avisa a las dos.

Nunca se pierde una seña: lo que el OCR no entiende va a revisión manual, no se descarta.

## Tests

`npm test` corre seis suites (276 chequeos): flujo completo, escenarios hostiles (señas falsas, carreras por el mismo horario, comandos mal usados, fuzzing), límites (bordes de agenda, persistencia, configuración cambiada a mitad de flujo), plantillas (una charla entera de barbería sin nada del salón de uñas, textos propios, la base de un celu instalado antes), comercio (consultas, un pedido de punta a punta, sin stock, la pausa) y Nodo Sur (vincular, configuración, catálogo y pedidos contra un sitio simulado). Corren con la configuración de ejemplo, sin `config.json`, y con los dos motores de SQLite.

## Prender, apagar y reiniciar (en el celu)

Todo con `bot.sh`, que hace apagado **total** (no reinicio caliente): baja el proceso, mata el daemon de PM2 y liquida cualquier node suelto antes de levantar de nuevo.

```bash
cd ~/bot-turnos
bash bot.sh prender      # arranca de cero
bash bot.sh apagar       # lo baja del todo (no vuelve ni al reiniciar el celu)
bash bot.sh reiniciar    # apagado total + arranque limpio
bash bot.sh estado       # ¿está vivo? memoria y uptime
bash bot.sh logs         # ver qué pasa en vivo (Ctrl+C para salir)
bash bot.sh revisar      # chequeo de salud completo
bash bot.sh vincular     # re-vincular WhatsApp (código nuevo)
bash bot.sh vincular-nodosur   # vincular a la cuenta de Nodo Sur (abre el navegador)
```

`bash bot.sh revisar` es lo primero que conviene correr cuando algo anda raro: chequea versión de Node, SQLite, Tesseract y el idioma español, validez de la config, si la sesión de WhatsApp está vinculada, tamaño de la base, turnos activos, espacio libre, wake-lock y arranque automático.

## Operación

- Panel: `http://localhost:3010` en el celu (estado, uptime, últimos eventos, reiniciar).
- Soporte remoto: Tailscale + SSH.
- Motor de base: better-sqlite3 en PC, SQLite incorporado de Node en el celu (`src/db/motor.js`).
- Backup: `scripts/backup.sh` (requiere `rclone config` una vez).
- Latido diario al `numero_soporte`: solo salud del sistema, nunca datos de clientas.
