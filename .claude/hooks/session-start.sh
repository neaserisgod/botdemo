#!/bin/bash
# Deja las dependencias del bot instaladas en las sesiones de Claude en la nube (como en el celular: sin las opcionales).
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"
npm install --omit=optional --no-audit --no-fund >/dev/null
