#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
# setup.sh — Aprovisionamiento de bot-turnos en Termux
# Uso: bash setup.sh [url-del-repo]
# Requisitos previos en el celu:
#   - Termux, Termux:Boot y Termux:API instalados (F-Droid, NO Play Store)
#   - Abrir Termux:Boot una vez a mano para habilitarlo
# ============================================================
set -e

REPO="${1:-}"
DIR="$HOME/bot-turnos"

echo "== [1/7] Paquetes base =="
pkg update -y
pkg install -y nodejs-lts git tesseract termux-api openssh

# Idioma español para el OCR (el paquete tesseract puede venir sin spa)
TESSDATA="$PREFIX/share/tessdata"
mkdir -p "$TESSDATA"
if [ ! -f "$TESSDATA/spa.traineddata" ]; then
  echo "Bajando idioma español para Tesseract..."
  curl -L -o "$TESSDATA/spa.traineddata" \
    https://github.com/tesseract-ocr/tessdata_fast/raw/main/spa.traineddata \
    || echo "AVISO: no se pudo bajar spa.traineddata; el OCR usará inglés (los montos y números salen igual)"
fi

echo "== [2/7] Código =="
if [ -f "$PWD/package.json" ] && [ -d "$PWD/src" ]; then
  # Ya estamos parados adentro del repo (no importa cómo se llame la carpeta)
  echo "Usando el repo de esta carpeta: $PWD"
  cd "$PWD"
elif [ -d "$DIR" ]; then
  echo "Ya existe $DIR, actualizando..."
  cd "$DIR" && git pull
elif [ -n "$REPO" ]; then
  git clone "$REPO" "$DIR" && cd "$DIR"
else
  echo "ERROR: no encontré el código."
  echo "  Opción A: entrá a la carpeta del repo (cd carpeta) y corré: bash setup.sh"
  echo "  Opción B: bash setup.sh <url-repo>"
  exit 1
fi

echo "== [3/7] Dependencias =="
# --omit=optional deja afuera whatsapp-web.js (Chromium, ~150 MB) y
# better-sqlite3 (no compila en Termux). El bot usa el SQLite que trae Node.
npm install --omit=optional

# Chequeo temprano: sin motor de SQLite no tiene sentido seguir
node -e "require('node:sqlite')" 2>/dev/null || {
  echo "ERROR: tu Node ($(node -v)) no trae SQLite incorporado (hace falta 22.5+)."
  echo "Probá: pkg upgrade nodejs-lts"
  exit 1
}

echo "== [4/7] Nodo Sur y configuración =="
# Con Nodo Sur, la configuración del bot (rubro, nombre, números, horarios) se carga en la app y baja sola. Sin Nodo Sur,
# o si todavía no se configuró en la app, se preguntan los datos acá y se arma config.json (fuera del repo: los git pull
# nunca lo tocan). Las preguntas leen de /dev/tty: el instalador puede venir de "curl … | bash".
pregunta() { local r; read -r -p "$1" r </dev/tty; printf '%s' "$r"; }

CONFIG_NUBE=1
if [ -f data/nodosur.json ]; then
  echo "Ya está vinculado a Nodo Sur."
  node scripts/nodosur-una-vuelta.js && CONFIG_NUBE=0
else
  R=$(pregunta "¿Vinculás el bot a tu cuenta de Nodo Sur? Así lo configurás desde la app. [S/n] ")
  if [ "$R" != "n" ] && [ "$R" != "N" ]; then
    node scripts/vincular-nodosur.js || echo "No se pudo vincular ahora. Más tarde: bash bot.sh vincular-nodosur"
    [ -f data/nodosur.json ] && node scripts/nodosur-una-vuelta.js && CONFIG_NUBE=0
  fi
fi

if [ "$CONFIG_NUBE" = "0" ]; then
  echo "La configuración viene de Nodo Sur."
elif [ -f config.json ]; then
  echo "config.json ya existe, lo dejo como está."
else
  echo ""
  echo "Unos datos del negocio (después se cambian desde la app de Nodo Sur, o con: nano config.json)."
  RUBRO="${RUBRO:-}"
  while ! node -e "process.exit(require('./src/plantillas').plantillaDe(process.argv[1]) ? 0 : 1)" "$RUBRO" 2>/dev/null; do
    RUBRO=$(pregunta "Rubro (almacen, kiosco, fiambreria, otro, unas, barberia, servicio): ")
  done
  NOMBRE=$(pregunta "Nombre del negocio: ")
  DIRECCION=$(pregunta "Dirección (para \"¿dónde están?\"): ")
  NUM_BOT=$(pregunta "Número del WhatsApp que atiende el bot (ej: 2944 123456): ")
  NUM_DUENA=$(pregunta "Tu número, para los avisos del bot (ej: 2944 654321): ")
  until node scripts/config-de-rubro.js "$RUBRO" --nombre "$NOMBRE" --direccion "$DIRECCION" --numero-bot "$NUM_BOT" --numero-duena "$NUM_DUENA"; do
    echo "Probemos de nuevo los números."
    NUM_BOT=$(pregunta "Número del WhatsApp que atiende el bot: ")
    NUM_DUENA=$(pregunta "Tu número, para los avisos: ")
  done
fi

echo "== [5/7] Vincular WhatsApp =="
npm install -g pm2
pm2 delete bot-turnos 2>/dev/null || true  # por si quedó de un intento anterior

# Ojo: creds.json existe apenas arranca Baileys, aunque NO esté vinculado.
# La sesión sirve solo si quedó registrada (registered + me).
SESION_OK=1
if [ -f data/sesion-baileys/creds.json ]; then
  node -e "const c=require('./data/sesion-baileys/creds.json'); process.exit(c.registered && c.me ? 0 : 1)" 2>/dev/null && SESION_OK=0
fi

if [ "$SESION_OK" = "0" ]; then
  echo "Ya hay una sesión vinculada ($(node -p "require('./data/sesion-baileys/creds.json').me.id.split(':')[0]" 2>/dev/null)), sigo."
else
  # Sesión a medias de un intento anterior: la limpiamos para empezar de cero
  rm -rf data/sesion-baileys
  NUM=$(node -e "process.stdout.write(require('./src/config').construir().config.numero_actual || '')" 2>/dev/null)
  echo ""
  echo "  El código se va a pedir para el número: $NUM"
  echo ""
  echo "  Es el número del WhatsApp que va a atender el bot (puede estar en OTRO celular:"
  echo "  el código se escribe en el celular que tiene ese WhatsApp)."
  echo "  549 + característica sin el 0 + número sin el 15 (ej: 2944 123456 → 5492944123456)."
  echo ""
  RESPUESTA=$(pregunta "  ¿Es ese el número? [s/N] ")
  if [ "$RESPUESTA" != "s" ] && [ "$RESPUESTA" != "S" ]; then
    echo ""
    echo "  Cambialo en la app de Nodo Sur, o con:  nano config.json   (campo numero_actual)"
    echo "  y volvé a correr: bash setup.sh"
    exit 1
  fi
  echo ""
  echo "Cuando aparezca el código, andá a: WhatsApp > Dispositivos vinculados >"
  echo "Vincular con el número de teléfono, y escribilo."
  echo ""
  node src/index.js --adaptador=baileys --pareo
fi

echo "== [5b] Arrancando el bot con PM2 =="
pm2 start ecosystem.config.js
pm2 save

echo "== [6/7] Termux:Boot (arranque automático al prender el celu) =="
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/arrancar-bot.sh <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
# Se ejecuta al prender el celu. Termux:Boot arranca con un entorno mínimo,
# así que fijamos PATH y HOME a mano.
export PREFIX=/data/data/com.termux/files/usr
export HOME=/data/data/com.termux/files/home
export PATH="$PREFIX/bin:$PATH"
export PM2_HOME="$HOME/.pm2"

# Que no lo suspenda Android con la pantalla apagada
termux-wake-lock

# SSH para soporte remoto (por Tailscale)
sshd 2>/dev/null

# Esperamos a que Android levante la red (si no, Baileys arranca a ciegas;
# igual reintenta solo, pero así evitamos ruido en los logs)
sleep 20

pm2 resurrect >> "$HOME/boot-bot.log" 2>&1
echo "$(date '+%Y-%m-%d %H:%M') boot ok" >> "$HOME/boot-bot.log"
EOF
chmod +x ~/.termux/boot/arrancar-bot.sh

echo "== [7/7] Wake-lock ahora =="
termux-wake-lock

echo ""
echo "============================================"
echo " ✅ El bot ya está corriendo."
echo ""
echo " Verificá con:   pm2 logs bot-turnos"
echo " Panel:          http://localhost:$(node -e "process.stdout.write(String(require('./src/config').construir().config.panel.puerto))" 2>/dev/null || echo 3010)"
echo ""
echo " Falta hacer a mano (una vez por celu):"
echo "  1. Ajustes > Apps > Termux > Batería > Sin restricciones"
echo "     (ídem Termux:Boot, para que no lo mate Android)"
echo "  2. Reiniciar el celu y ver que levante solo: pm2 logs bot-turnos"
echo "  3. Instalar Tailscale y loguear el celu (soporte remoto)"
echo "  4. Backup diario: rclone config + cron con scripts/backup.sh"
echo "============================================"
