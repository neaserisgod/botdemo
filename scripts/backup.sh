#!/data/data/com.termux/files/usr/bin/bash
# Backup diario del .db a la nube (rclone configurado aparte: rclone config).
# Cron sugerido en el celu: pm2 no hace falta, usar cronie o un cron de node.
set -e
DIR="$HOME/bot-turnos/data"
FECHA=$(date +%Y%m%d)
# Copia consistente aunque el bot esté escribiendo (WAL): usar .backup de sqlite
sqlite3 "$DIR/turnos.db" ".backup '$DIR/backup_$FECHA.db'"
rclone copy "$DIR/backup_$FECHA.db" nube:backups-bot-turnos/ && rm "$DIR/backup_$FECHA.db"
# Conservar solo últimos 7 en la nube
rclone delete nube:backups-bot-turnos/ --min-age 7d || true
