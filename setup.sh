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
if [ -d "$DIR" ]; then
  echo "Ya existe $DIR, actualizando..."
  cd "$DIR" && git pull
elif [ -n "$REPO" ]; then
  git clone "$REPO" "$DIR" && cd "$DIR"
else
  echo "ERROR: no existe $DIR y no pasaste URL de repo. Uso: bash setup.sh <url-repo>"
  exit 1
fi

echo "== [3/7] Dependencias (sin whatsapp-web.js: en el celu va Baileys) =="
# --omit=optional evita que intente bajar Chromium en el celu
npm install --omit=optional

echo "== [4/7] config.json =="
if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo ">>> IMPORTANTE: editá config.json con los datos del cliente (nano config.json)"
fi

echo "== [5/7] PM2 =="
npm install -g pm2
pm2 start ecosystem.config.js || true
pm2 save

echo "== [6/7] Termux:Boot (arranque automático al prender el celu) =="
mkdir -p ~/.termux/boot
cat > ~/.termux/boot/arrancar-bot.sh <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
# Se ejecuta al bootear el celu: wake-lock + PM2 con el bot
termux-wake-lock
sshd
export PM2_HOME=$HOME/.pm2
pm2 resurrect
EOF
chmod +x ~/.termux/boot/arrancar-bot.sh

echo "== [7/7] Wake-lock ahora =="
termux-wake-lock

echo ""
echo "============================================"
echo " Listo. Pasos manuales que quedan:"
echo "  1. nano config.json  (datos del cliente)"
echo "  2. Vincular WhatsApp (el QR no sirve en el mismo celu, usar código):"
echo "     pm2 delete bot-turnos"
echo "     node src/index.js --adaptador=baileys --pareo"
echo "     → meter el código en WhatsApp > Dispositivos vinculados"
echo "     → Ctrl+C cuando diga 'WhatsApp conectado', y de nuevo:"
echo "     pm2 start ecosystem.config.js && pm2 save"
echo "  3. pm2 logs bot-turnos  → verificar que conecta"
echo "  4. Desactivar optimización de batería para Termux"
echo "     (Ajustes > Apps > Termux > Batería > Sin restricciones)"
echo "  5. Instalar Tailscale y loguear el celu (soporte remoto)"
echo "  6. Configurar backup diario del .db (scripts/backup.sh + cron)"
echo "============================================"
