#!/usr/bin/env bash
# Version erhöhen: scripts/bump.sh [patch|minor|major]  (Standard: patch)
set -e
cd "$(dirname "$0")/.."
V=$(grep '^version=' version.properties | cut -d= -f2 | tr -d '\r')
IFS=. read -r A B C <<< "$V"
case "${1:-patch}" in
  major) A=$((A+1)); B=0; C=0 ;;
  minor) B=$((B+1)); C=0 ;;
  patch) C=$((C+1)) ;;
  *) echo "patch|minor|major"; exit 1 ;;
esac
printf 'version=%s.%s.%s\n' "$A" "$B" "$C" > version.properties
echo "$V -> $A.$B.$C"
