#!/usr/bin/env bash
# Backs up the database + all originals into /srv/revx-backups, keeps the last 14.
set -euo pipefail
SRC="${1:-/srv/revx/data}"
DEST="${2:-/srv/revx-backups}"
mkdir -p "$DEST"
STAMP="$(date +%Y-%m-%d_%H%M)"
# consistent copy of the SQLite file while the site is running
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$SRC/studio.sqlite" ".backup '$DEST/studio-$STAMP.sqlite'"
else
  cp "$SRC/studio.sqlite" "$DEST/studio-$STAMP.sqlite"
fi
tar -czf "$DEST/uploads-$STAMP.tgz" -C "$SRC" uploads derived 2>/dev/null || true
ls -1t "$DEST"/studio-*.sqlite | tail -n +15 | xargs -r rm -f
ls -1t "$DEST"/uploads-*.tgz | tail -n +15 | xargs -r rm -f
echo "Backup written to $DEST ($STAMP)"
