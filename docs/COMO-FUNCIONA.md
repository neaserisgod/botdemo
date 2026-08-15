# Cómo funciona bot-turnos

Documentación técnica del proyecto: qué hace, con qué está hecho, cómo se mueve un mensaje por dentro y por qué cada decisión es la que es.

Si lo que buscás es *instalarlo*, andá al [README](../README.md). Esto es el "cómo funciona".

---

## 1. Qué es, en tres líneas

Un bot de WhatsApp que atiende a las clientas de un negocio chico y les agenda turnos solo: les muestra los servicios, los horarios libres, toma la seña por transferencia (leyendo el comprobante con OCR), manda recordatorios el día antes y le avisa todo a la dueña por WhatsApp.

Corre entero dentro de un celular Android reacondicionado. No hay servidor, no hay nube, no hay servicios pagos. El costo mensual de infraestructura es cero.

Son ~2.100 líneas de JavaScript (más ~600 de tests), sin frameworks, sin build, sin TypeScript.

---

## 2. El stack, y por qué cada pieza

| Pieza | Para qué | Por qué esta y no otra |
|---|---|---|
| **Node.js 22+** | Todo el bot | Es lo que hay en Termux (`nodejs-lts`) y no necesita compilar |
| **Baileys** | Hablar con WhatsApp | Implementa el protocolo de WhatsApp Web directo, por WebSocket. La alternativa (`whatsapp-web.js`) maneja un Chrome de verdad por debajo: 400-600 MB de RAM y no arranca en un celu modesto |
| **SQLite** | Guardar todo | Un archivo, cero configuración, transaccional. Perfecto para un solo negocio con un solo proceso escribiendo |
| **Tesseract (binario)** | Leer los comprobantes | El binario nativo de Termux (`pkg install tesseract`). La versión JS (`tesseract.js`) carga el modelo en memoria y es mucho más pesada |
| **PM2** | Que el bot no se muera | Lo reinicia si crashea o si se pasa de RAM, y lo levanta al prender el celu |
| **node-cron** | Tareas programadas | Recordatorios, agenda diaria, latido. Dentro del mismo proceso, sin cron del sistema |
| **Express** | Panel de estado | Solo para servir una página en localhost. Es la única dependencia "de servidor" y ni siquiera sale del celu |

Lo que **no** usa, a propósito: sin IA ni APIs pagas (el lenguaje natural es un diccionario), sin API oficial de WhatsApp Business (cobra por conversación), sin base de datos de servidor, sin frontend, sin Docker.

### Los dos motores de SQLite

`src/db/motor.js` elige solo:

1. **better-sqlite3** si está instalado (en la PC). Es más rápido y más probado.
2. **`node:sqlite`**, el SQLite que viene *dentro* de Node 22.5+, si el primero no está.

Existe porque better-sqlite3 es C++ y hay que compilarlo, y en Termux la compilación falla: node-gyp no encuentra el NDK de Android (`Undefined variable android_ndk_path`). En vez de pelear con eso en cada celu que instalemos, en el celu no se instala y se usa el motor incorporado. Las tres suites de tests pasan con los dos motores, así que son intercambiables.

---

## 3. La idea central: el núcleo no sabe qué es WhatsApp

Es la decisión de diseño más importante del proyecto. Toda la lógica de negocio vive en `src/core/` y **no importa ninguna librería de WhatsApp**. Habla en mensajes planos:

```js
// lo que entra
{ de: "5492944123456", texto: "hola", rutaImagen: null, productoId: null }

// lo que sale
[ { para: "5492944123456", texto: "¡Hola! ¿Qué necesitás?", imagenRuta: null } ]
```

Un **adaptador** traduce entre eso y la librería de turno. Hay tres:

| Adaptador | Uso |
|---|---|
| `baileys.js` | Producción (celu) y pruebas reales |
| `consola.js` | Probar el flujo entero en la terminal, sin WhatsApp |
| `whatsappweb.js` | Alternativa en PC (arrastra Chromium) |

Se elige al arrancar: `node src/index.js --adaptador=baileys`.

Esto es lo que permitió, entre otras cosas, migrar de whatsapp-web.js a Baileys sin tocar una línea de lógica de negocio, y tener 167 tests que corren sin WhatsApp.

---

## 4. El viaje de un mensaje, punta a punta

Clienta escribe *"hola quería un turno para mañana a las 11"*:

```
WhatsApp
   │
   ▼
adaptadores/baileys.js ── traduce el mensaje de Baileys a { de, texto, ... }
   │                      (si vino foto, la baja a data/comprobantes/)
   ▼
core/motor.js ─────────── ¿quién escribe?
   │                       • numero_duena  → duena.js (comandos y lenguaje natural)
   │                       • numero_soporte→ ignorar
   │                       • ¿derivada a humano? → silencio
   │                       • si no → clienta
   ▼
core/maquina.js ───────── ¿en qué punto de la conversación está?
   │                      (el estado se lee de la DB, no de la memoria)
   ▼
core/nlu.js ───────────── ¿qué quiso decir? intención + servicio + fecha/hora
   ▼
core/agenda.js ────────── ¿qué horarios quedan libres?
   │                      (consulta turnos y descarta los que se pisan)
   ▼
db/ ───────────────────── guarda el estado y el turno
   │
   ▼
devuelve [ { para, texto } ] ──► adaptador ──► WhatsApp
```

El adaptador es lo único que toca la red. El núcleo es una función pura-ish: mensaje entra, mensajes salen.

---

## 5. La conversación (`core/maquina.js`)

Una máquina de estados clásica. Ocho estados:

```
inicio ──► eligiendo_servicio ──► eligiendo_dia ──► eligiendo_hora
  │                                                       │
  │                                                       ▼
  │                                              pidiendo_nombre (si no lo sabemos)
  │                                                       │
  │                                                       ▼
  ├─ "cancelar"       → cancelando                   confirmando
  ├─ FAQ              → responde y queda en inicio   ┌────┴────────┐
  ├─ "confirmo"       → responde el recordatorio  con seña      sin seña
  └─ 2 sin entender   → deriva a humano      esperando_comprobante  ✔ confirmado
                                                  │
                                    foto → OCR → ✔ verificado | ⚠ a_revisar
                                    2 hs sin foto → ✘ vencido (libera el horario)
```

**El estado vive en la base, no en memoria.** La tabla `clientas` tiene `estado_conv` (dónde está) y `datos_conv` (un JSON con lo que ya eligió). Por eso el bot puede reiniciarse en medio de una conversación y la clienta ni se entera. Si ese JSON se corrompe, se descarta y la conversación vuelve al menú, en vez de tumbar el proceso.

### Entender lenguaje natural sin IA (`core/nlu.js`)

Son 145 líneas y tres técnicas simples:

1. **Normalizar**: saca tildes, mayúsculas y signos. `"¿Cuánto sale?"` → `"cuanto sale"`.
2. **Diccionario de intenciones**: listas de palabras clave por intención (reservar, cancelar, confirmar, hablar con humano, saludo). El orden importa: *"quiero cancelar el turno"* tiene que dar `cancelar`, no `reservar`.
3. **Distancia de edición de 1**: tolera un typo por palabra en palabras de 5+ letras. Por eso `"kaping"` encuentra Kapping y `"presios"` dispara la FAQ de precios.

Además extrae **fecha y hora** del texto libre: `"mañana"`, `"pasado mañana"`, `"el viernes"`, `"20/8"`, `"día 25"`, `"a las 11"`, `"16:30"`, `"4 de la tarde"`. Si el mensaje trae servicio + día + hora, la máquina se saltea esos pasos y va derecho a pedir el nombre.

Un detalle que costó: hay que borrar `"de la mañana"` del texto antes de buscar el día, o *"a las 9 de la **mañana** el lunes"* agenda para mañana en vez del lunes.

---

### Del lado de la dueña (`core/nlu-duena.js` + `core/duena.js`)

La dueña no tiene que aprender comandos: le escribe al bot como le sale.

| Ella escribe | El bot entiende |
|---|---|
| "qué tengo hoy", "cómo viene la agenda" | Agenda del día |
| "cómo viene la semana" | Próximos 7 días |
| "quién es el turno 5", "detalle del 5" | Ficha del turno |
| "aprobá la seña del 5", "la 5 está bien" | Aprobar seña |
| "rechazá la 5", "esa seña es trucha, la 5" | Rechazar seña |
| "anulá el turno 3", "borrá el 3" | Anular turno |
| "precios", "cuánto cobro" | Lista de precios |
| "el kapping ahora sale 30000" | Cambiar precio |

Los atajos con `!` (`!hoy`, `!ok 5`, `!anular 3`) siguen funcionando para quien los prefiera.

**Las acciones que borran algo se confirman.** Si la dueña dice "anulá el turno 3" o "rechazá la 5" en lenguaje natural, el bot repite en voz alta qué va a hacer (con día, hora, servicio y clienta) y espera un "sí". Con el comando `!anular 3` se ejecuta directo, porque escribirlo así es inequívoco. La confirmación pendiente vive en memoria y vence a los 5 minutos: si el bot se reinicia en el medio, se pierde y hay que repetirla — preferible a ejecutar algo viejo que quedó colgado.

#### Aviso masivo a todas las clientas

`aviso <mensaje>` (o *"avisale a todas que..."*) le manda un mensaje a todas las clientas de la base. Tres recaudos, porque es la función más peligrosa del bot:

- **Siempre pide confirmación**, incluso con `!aviso`: muestra el texto tal cual va a salir y a cuántas personas le llega. No hay forma de despublicarlo una vez enviado.
- **Los envíos van espaciados 6 segundos.** Mandar cien mensajes de golpe es la forma más rápida de que WhatsApp bloquee la cuenta. Cien clientas son diez minutos de envío; el bot avisa cuánto va a tardar y avisa cuando termina.
- La dueña y el número de soporte quedan siempre excluidos.

El espaciado se implementa con un campo `demora` en el mensaje saliente: el núcleo solo lo declara, y el adaptador es el que espera antes de mandar.

#### Turnos al calendario del celular (`core/calendario.js`)

Cuando un turno queda confirmado, la dueña recibe un archivo `.ics` adjunto: lo toca y Android o iOS le ofrecen agregarlo al calendario, con alarma 30 minutos antes. El evento incluye clienta, teléfono, servicio, precio y la dirección del negocio.

Se eligió `.ics` sobre la API de Google Calendar porque no necesita credenciales, ni OAuth, ni cuenta de Google, ni internet. Es un archivo de texto que todos los calendarios entienden desde hace veinte años.

Además, el panel expone `/calendario.ics` con los turnos de los últimos 7 y próximos 60 días. Si se activa `panel.escuchar_en_red`, la dueña puede suscribir su app de calendario a `http://<ip-del-celu>:3010/calendario.ics` estando en la misma WiFi, y ve todo sin tocar nada.

## 6. Las señas (`core/flujos/senas.js` + `core/ocr.js`)

Es la parte más delicada, porque hay plata de por medio.

**El flujo:**

1. La clienta confirma → el turno se crea como `pendiente_sena` y **ya ocupa el horario** (para que nadie se lo saque mientras paga).
2. Recibe alias, titular, monto y plazo (2 hs por defecto).
3. Manda la foto → se baja a disco → Tesseract la lee → regex extraen **monto, destinatario, número de operación y fecha**.
4. Se aplican las reglas. Si pasa todas → `verificado`, turno confirmado, la dueña recibe la foto con los datos. Si falla alguna → `a_revisar`.
5. Si a las 2 hs no llegó nada → `vencido`, el horario se libera y se les avisa a las dos.

**Las reglas que mandan una seña a revisión:**

- No se pudo leer nada del comprobante
- No aparece número de operación
- **El número de operación ya se usó** (columna `UNIQUE` en la base — es la defensa contra la clienta que reenvía el mismo comprobante para dos turnos)
- El monto es menor a la seña
- El destinatario no coincide con el titular configurado

**Nada se descarta nunca.** Todo lo dudoso va a `a_revisar` con la foto y el motivo, y la dueña resuelve con `!ok 7` o `!no 7`. Un OCR que falla nunca hace perder una seña ni un turno.

**El OCR tiene tres niveles de respaldo**: intenta con español → si no está el paquete de idioma, con inglés (los montos y números salen igual) → si no hay Tesseract, usa el texto que acompaña la foto. Está validado contra un comprobante real de Mercado Pago, que quedó clavado como test de regresión.

> **Por qué no usamos la API de Mercado Pago:** requeriría las credenciales de la cuenta del cliente. Pedirle a una dueña de salón acceso a su cuenta bancaria es una barrera de venta enorme y una responsabilidad que no queremos. El OCR es menos exacto pero no toca la plata de nadie.

---

## 7. La base de datos (`src/db/`)

Cinco tablas, todas en `data/turnos.db`:

| Tabla | Qué guarda |
|---|---|
| `clientas` | Un registro por número. Nombre, **estado de la conversación**, cuántas veces seguidas no la entendimos, hasta cuándo está derivada a un humano |
| `servicios` | Espejo de `config.json`, sembrado al arrancar. En runtime **la base es la fuente de verdad de los precios** (por eso `!precio` los cambia sin editar archivos) |
| `turnos` | Inicio, fin, estado, si ya se mandó el recordatorio |
| `senas` | Estado, monto esperado vs detectado, datos del OCR, `nro_operacion` **UNIQUE** |
| `eventos_conectividad` | Arranques, caídas, reconexiones, batería, latidos |

**Cómo se evitan los solapamientos:** cada turno guarda `inicio` y `fin` ya calculados, y antes de crear uno se pregunta si existe algún turno activo donde `inicio < nuevo_fin AND fin > nuevo_inicio`. Se chequea dos veces: al mostrar los horarios libres y **otra vez al confirmar**, porque entre que la clienta vio la lista y apretó el número pudo pasar un minuto y entrar otra. Hay un test que hace reservar a 40 clientas seguidas y verifica con SQL que no quedó ni un solapamiento.

Los estados que ocupan agenda son `pendiente_sena` y `confirmado`. Cualquier otro (`cancelado`, `anulado`, `vencido`, `completado`) libera el horario automáticamente, porque las consultas filtran por estado. No hay que "borrar" nada.

---

## 8. Lo que pasa solo (`core/recordatorios.js` + `src/index.js`)

Cinco tareas programadas con `node-cron`:

| Cuándo | Qué hace |
|---|---|
| Cada 5 min | Manda los recordatorios de 24 hs y vence las señas sin comprobante |
| Cada 5 min | Chequea la batería (avisa si se cortó la luz) |
| 08:30 | Agenda del día a la dueña |
| Domingo 20:00 | Resumen de la semana |
| 09:00 | Latido al número de soporte |

**El catch-up es gratis por diseño.** La consulta de recordatorios pide "turnos confirmados, sin recordatorio enviado, que empiezan dentro de las próximas 24 hs". Si el bot estuvo apagado seis horas, al arrancar esa misma consulta devuelve todo lo que quedó pendiente y se despacha. No hace falta una cola ni recuperar nada: el estado está en la base y la consulta es idempotente.

Las tareas solo despachan si hay conexión; si no, quedan para el próximo tick.

---

## 9. Resiliencia: qué pasa si...

| Situación | Qué hace el bot |
|---|---|
| Se corta el WiFi | Baileys reintenta cada 5 s. Al volver, le avisa a la dueña cuánto estuvo caído |
| Se corta la luz | El celu sigue con batería y datos móviles. Avisa a la dueña que quedó desenchufado, y de nuevo cuando vuelve |
| Se reinicia el celu | Termux:Boot toma el wake-lock, espera 20 s a que haya red y hace `pm2 resurrect`. La sesión de WhatsApp está en disco: no pide QR |
| El bot crashea | PM2 lo reinicia. Como el estado de cada conversación está en la base, siguen donde estaban |
| Se infla la memoria | PM2 lo reinicia al pasar los 300 MB |
| Android quiere matar el proceso | `termux-wake-lock` + batería sin restricciones |
| El OCR no entiende un comprobante | Va a revisión manual, con foto y motivo |
| Dos clientas quieren el mismo horario | La segunda recibe aviso y vuelve a elegir |
| El bot no entiende dos veces seguidas | Deriva a la dueña, se calla 12 hs y le pasa el mensaje textual |

El principio detrás de todo esto: **ante la duda, molestar a un humano; nunca perder plata ni un turno en silencio.**

---

## 10. Salud y soporte (`src/salud/`, `src/panel/`)

- **Panel** en `http://localhost:3010` (solo dentro del celu): estado de conexión, uptime, turnos de hoy, últimos eventos y botón de reinicio.
- **Latido diario** al número de soporte: `[Negocio] bot activo | uptime 34 hs | batería 87%`. **Solo salud del sistema, nunca contenido de clientas** — esto es deliberado y es lo que le podés decir al cliente cuando pregunte qué ves vos.
- **Soporte remoto**: Tailscale + SSH, para entrar al celu sin pedirle nada a la dueña.
- **Backup**: `scripts/backup.sh` copia el `.db` a la nube con rclone.

---

## 11. Configuración (`config.json` + `src/config.js`)

Todo lo que cambia entre clientes está en un solo archivo: datos del negocio, números (dueña, soporte, el del bot), horarios por día, servicios (duración, precio, seña), alias y titular de MP, y las palabras clave de la FAQ.

Al arrancar, `src/config.js` lo valida y, si algo está mal, **no arranca** y explica qué en castellano: número sin `549`, seña mayor al precio, horario invertido, día faltante, todos los días cerrados, formato de hora incorrecto. Existe porque el momento de dar de alta un cliente es cuando más fácil es equivocarse, y un error de tipeo silencioso ahí se descubre tres días después con turnos mal agendados.

---

## 12. Tests

Tres suites, 167 chequeos, corren sin WhatsApp con `npm test`:

- **`simulacion.js`** — el flujo completo: reservar, señar, recordar, cancelar, comandos, FAQ, catálogo, lenguaje natural.
- **`escenarios.js`** — lo que sale mal: comprobantes con monto corto, destinatario ajeno o duplicados; carreras por el mismo horario; comandos mal usados; 40 clientas reservando en cadena; fuzzing con inyección SQL, textos de 5.000 caracteres y bytes nulos.
- **`limites.js`** — los bordes: domingo cerrado, último turno del día, anticipación mínima, reinicio a mitad de conversación, `datos_conv` corrupto, servicio desactivado mientras alguien lo elige, derivación que expira, recordatorios que **no** deben salir.

Que corran sin WhatsApp es consecuencia directa de tener el núcleo desacoplado: se le pasan mensajes planos al motor y se mira qué devuelve.

---

## 13. Cómo agregar cosas

| Quiero... | Toco |
|---|---|
| Un servicio nuevo | `config.json` → `servicios` |
| Que entienda otra forma de decir algo | `core/nlu.js` → el diccionario de intenciones |
| Otra pregunta frecuente | `config.json` → `faq` y `core/flujos/faq.js` |
| Un comando nuevo para la dueña | `core/duena.js` → el `switch` |
| Un paso más en la conversación | `core/maquina.js` → un estado nuevo + agregarlo al objeto `manejadores` |
| Otro formato de comprobante | `core/ocr.js` → los regex de `parsear()` |
| Soportar otra librería de WhatsApp | Un archivo nuevo en `adaptadores/` (el núcleo no se toca) |

Regla que conviene mantener: **si el archivo está en `core/`, no puede importar nada de WhatsApp**. Es lo que mantiene todo testeable.
