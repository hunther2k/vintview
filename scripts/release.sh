#!/usr/bin/env bash
# Release: scripts/release.sh "Neu: …" "Fix: …"
# Setzt das Tag vX.Y.Z (mit den Zeilen als Release-Notizen) und pusht.
# GitHub Actions baut daraufhin die signierte APK und veröffentlicht das Release.
set -e
cd "$(dirname "$0")/.."
V=$(grep '^version=' version.properties | cut -d= -f2 | tr -d '\r')
[ -z "$(git status --porcelain)" ] || { echo "Arbeitsverzeichnis nicht sauber – erst committen."; exit 1; }
git rev-parse "v$V" >/dev/null 2>&1 && { echo "Tag v$V gibt es schon – erst scripts/bump.sh"; exit 1; }
[ $# -gt 0 ] || { echo "Bitte Release-Notizen angeben."; exit 1; }
MSG="Vintview $V"$'\n\n'"$(printf -- '- %s\n' "$@")"
git tag -a "v$V" -m "$MSG"
git push origin HEAD "v$V"
echo "v$V gepusht – Build läuft: https://github.com/hunther2k/vintview/actions"
