#!/data/data/com.termux/files/usr/bin/bash
# ============================================================
# Instalador de un solo comando, para pegar en Termux:
#
#   curl -fsSL https://raw.githubusercontent.com/neaserisgod/botdemo/main/instalar.sh | bash
#
# Antes (una sola vez): instalar Termux, Termux:Boot y Termux:API desde F-Droid
# (NO de Play Store) y abrir Termux:Boot una vez.
#
# Baja el bot (o lo actualiza si ya estaba) y sigue con setup.sh, que instala lo
# que falta, ofrece vincularlo a Nodo Sur, pregunta los datos del negocio si
# hace falta y deja WhatsApp vinculado y el bot andando.
# ============================================================
set -e

REPO="${REPO:-https://github.com/neaserisgod/botdemo}"
RAMA="${RAMA:-main}"
DIR="$HOME/bot-turnos"

if [ ! -d /data/data/com.termux ]; then
  echo "Esto es para Termux, en el celular Android que va a atender el bot."
  exit 1
fi

echo "== Bajando el bot =="
pkg install -y git curl >/dev/null
if [ -d "$DIR/.git" ]; then
  echo "Ya estaba en $DIR: lo actualizo."
  git -C "$DIR" pull --ff-only
else
  git clone --depth 1 --branch "$RAMA" "$REPO" "$DIR"
fi

# setup.sh hace preguntas: que las lea del teclado y no del "curl … | bash".
cd "$DIR"
bash setup.sh </dev/tty
