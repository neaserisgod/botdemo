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

echo "== [4/7] config.json =="
if [ ! -f config.json ]; then
  cp config.example.json config.json
fi
echo ">>> Revisá config.json con los datos del cliente: nano config.json"

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
  NUM=$(node -p "require('./config.json').numero_actual" 2>/dev/null)
  echo ""
  echo "  El código se va a pedir para el número: $NUM"
  echo ""
  echo "  Tiene que ser el número del chip DE ESTE celu:"
  echo "  549 + característica sin el 0 + número sin el 15."
  echo "  (ej: Bariloche 2944 123456 → 5492944123456)"
  echo ""
  read -r -p "  ¿Es ese el número? [s/N] " RESPUESTA
  if [ "$RESPUESTA" != "s" ] && [ "$RESPUESTA" != "S" ]; then
    echo ""
    echo "  Editalo con:  nano config.json   (campo numero_actual)"
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
echo " Panel:          http://localhost:$(node -p "require('./config.json').panel.puerto" 2>/dev/null || echo 3010)"
echo ""
echo " Falta hacer a mano (una vez por celu):"
echo "  1. Ajustes > Apps > Termux > Batería > Sin restricciones"
echo "     (ídem Termux:Boot, para que no lo mate Android)"
echo "  2. Reiniciar el celu y ver que levante solo: pm2 logs bot-turnos"
echo "  3. Instalar Tailscale y loguear el celu (soporte remoto)"
echo "  4. Backup diario: rclone config + cron con scripts/backup.sh"
echo "============================================"
