#!/usr/bin/env bash
# Lokaler Build: scripts/build.sh [assembleRelease|assembleDebug|…]
# Hält Gradle-/Kotlin-Caches aus dem (synchronisierten) Projektordner heraus.
set -e
cd "$(dirname "$0")/.."
[ -f /d/Start/_tools/android/env.sh ] && source /d/Start/_tools/android/env.sh
CACHE="${VV_CACHE:-D:/Start/_build/vintview/cache}"
./gradlew --project-cache-dir "$CACHE/gradle" -Pkotlin.project.persistent.dir="$CACHE/kotlin" "${@:-assembleRelease}"
