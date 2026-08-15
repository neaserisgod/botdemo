#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
# Control del bot. Uso:  bash bot.sh <accion>
#
#   prender     arranca de cero (mata todo y levanta limpio)
#   apagar      lo baja del todo, no vuelve ni al reiniciar el celu
#   reiniciar   apagado total + arranque limpio (NO es hot reload)
#   estado      ver si está vivo, memoria y uptime
#   logs        ver qué está pasando en vivo (Ctrl+C para salir)
#   vincular    volver a vincular WhatsApp (pide código nuevo)
#   revisar     chequeo de salud: config, sesión, base, espacio
# ============================================================
cd "$(dirname "$0")" || exit 1
ACCION="${1:-ayuda}"

# Baja TODO: el bot, el daemon de PM2 y cualquier node suelto del proyecto.
# Es lo que hace que el arranque sea "desde cero" y no un reinicio caliente.
apagar_todo() {
  echo "→ Frenando el bot..."
  pm2 delete bot-turnos >/dev/null 2>&1
  echo "→ Matando el daemon de PM2..."
  pm2 kill >/dev/null 2>&1
  echo "→ Buscando procesos sueltos..."
  pkill -f "node .*bot-turnos/src/index.js" 2>/dev/null
  sleep 2
  local vivos
  vivos=$(pgrep -f "bot-turnos/src/index.js" | wc -l)
  if [ "$vivos" -gt 0 ]; then
    echo "  Quedaron $vivos procesos, los mato a la fuerza..."
    pkill -9 -f "bot-turnos/src/index.js" 2>/dev/null
    sleep 1
  fi
  echo "✅ Todo apagado."
}

case "$ACCION" in
  prender|start)
    apagar_todo
    echo ""
    echo "→ Arrancando limpio..."
    termux-wake-lock 2>/dev/null
    pm2 start ecosystem.config.js || { echo "❌ No arrancó. Mirá: bash bot.sh logs"; exit 1; }
    pm2 save >/dev/null 2>&1
    sleep 3
    pm2 status
    echo ""
    echo "✅ Andando. Verificá con:  bash bot.sh logs"
    ;;

  apagar|stop)
    apagar_todo
    echo ""
    echo "El bot NO va a volver solo, ni siquiera al reiniciar el celu."
    echo "Para volver a prenderlo:  bash bot.sh prender"
    ;;

  reiniciar|restart)
    echo "=== REINICIO DESDE CERO ==="
    apagar_todo
    echo ""
    echo "→ Arrancando limpio..."
    termux-wake-lock 2>/dev/null
    pm2 start ecosystem.config.js || { echo "❌ No arrancó. Mirá: bash bot.sh logs"; exit 1; }
    pm2 save >/dev/null 2>&1
    sleep 3
    pm2 status
    echo ""
    echo "✅ Reiniciado. Verificá con:  bash bot.sh logs"
    ;;

  estado|status)
    pm2 status
    echo ""
    echo "Procesos del bot corriendo: $(pgrep -f 'bot-turnos/src/index.js' | wc -l)"
    ;;

  logs)
    pm2 logs bot-turnos --lines 40
    ;;

  vincular)
    echo "Esto borra la sesión actual de WhatsApp y pide un código nuevo."
    read -r -p "¿Seguro? [s/N] " R
    [ "$R" != "s" ] && [ "$R" != "S" ] && { echo "Cancelado."; exit 0; }
    apagar_todo
    rm -rf data/sesion-baileys
    echo ""
    node src/index.js --adaptador=baileys --pareo
    echo ""
    echo "→ Arrancando el bot..."
    pm2 start ecosystem.config.js && pm2 save >/dev/null 2>&1
    pm2 status
    ;;

  revisar|check)
    echo "=== CHEQUEO DE SALUD ==="
    echo -n "Node:            "; node -v
    echo -n "SQLite en Node:  "; node -e "require('node:sqlite');console.log('ok')" 2>/dev/null || echo "NO (hace falta Node 22.5+)"
    echo -n "Tesseract:       "; command -v tesseract >/dev/null && tesseract --version 2>/dev/null | head -1 || echo "NO instalado (el OCR usará el texto de la foto)"
    echo -n "Español OCR:     "; tesseract --list-langs 2>/dev/null | grep -q spa && echo "ok" || echo "NO (va a leer en inglés)"
    echo -n "config.json:     "; node -e "require('./src/config').cargar();console.log('válida')" 2>&1 | tail -1
    echo -n "Sesión WhatsApp: "; node -e "const c=require('./data/sesion-baileys/creds.json');console.log(c.registered&&c.me?'vinculada ('+c.me.id.split(':')[0]+')':'INCOMPLETA')" 2>/dev/null || echo "NO vinculada"
    echo -n "Base de datos:   "; [ -f data/turnos.db ] && echo "$(du -h data/turnos.db | cut -f1)" || echo "todavía no existe"
    echo -n "Turnos activos:  "; node -e "process.env.RUTA_DB='./data/turnos.db';const db=require('./src/db');db.abrir('./data/turnos.db');console.log(db.obtener().prepare(\"SELECT COUNT(*) n FROM turnos WHERE estado IN ('pendiente_sena','confirmado')\").get().n)" 2>/dev/null || echo "?"
    echo -n "Espacio libre:   "; df -h "$HOME" 2>/dev/null | tail -1 | awk '{print $4}'
    # Ojo: el wake-lock NO es un proceso (termux-wake-lock avisa a la app y
    # termina), así que no se puede detectar con pgrep. Lo tomamos de nuevo,
    # que es inofensivo, y se confirma mirando la notificación de Termux.
    echo -n "Wake-lock:       "
    if command -v termux-wake-lock >/dev/null 2>&1; then
      termux-wake-lock 2>/dev/null && echo "tomado (verificá que la notificación de Termux diga 'wake lock held')" \
        || echo "falló al tomarlo"
    else
      echo "termux-wake-lock no está (pkg install termux-api)"
    fi
    echo -n "Arranque al boot:"; [ -f ~/.termux/boot/arrancar-bot.sh ] && echo " configurado" || echo " NO configurado"
    echo -n "Batería Termux:   "; echo "revisá a mano: Ajustes > Apps > Termux > Batería = Sin restricciones"
    echo ""
    echo "--- Últimas caídas y reconexiones ---"
    node -e "
      process.env.RUTA_DB='./data/turnos.db';
      const db=require('./src/db'); db.abrir('./data/turnos.db');
      const ev=db.obtener().prepare(\"SELECT tipo,detalle,creado_en FROM eventos_conectividad WHERE tipo IN ('caida','reconexion','arranque') ORDER BY id DESC LIMIT 8\").all();
      if(!ev.length) console.log('  (sin eventos registrados)');
      ev.forEach(e=>console.log('  '+e.creado_en+'  '+e.tipo+(e.detalle?'  '+e.detalle:'')));
    " 2>/dev/null || echo "  (no pude leer la base)"
    echo ""
    pm2 status
    ;;

  *)
    sed -n '/^# Control del bot/,/^#   revisar/p' "$0" | sed 's|^# \?||'
    ;;
esac
