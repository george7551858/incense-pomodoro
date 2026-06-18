#!/usr/bin/env bash
# Stamp the current UTC timestamp into sw.js VERSION so the browser detects the
# SW change and refreshes its cache.
# Usage: run once after changing CORE files, before deploying/committing: ./stamp-sw.sh
set -euo pipefail
cd "$(dirname "$0")"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
NEW="incense-pomodoro-${STAMP}"

sed -i -E "s|^const VERSION = \".*\";|const VERSION = \"${NEW}\";|" sw.js

echo "sw.js VERSION -> ${NEW}"
