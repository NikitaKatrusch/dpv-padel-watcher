#!/usr/bin/env bash
# Liest die öffentlichen JS-Dateien des Portals und listet darin vorkommende API-Pfade.
# Es wird nichts ausprobiert, nur gelesen.
set -u
BASE=${BASE:-https://portal.dpv-padel.de}
UA=${UA:-'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'}
OUT=${OUT:-debug}
W=$(mktemp -d)
mkdir -p "$OUT" "$W/js"
get() { curl -sS -m 30 -A "$UA" "$@"; }

get "$BASE/" -o "$W/index.html"
get "$BASE/config.js" -o "$OUT/config.js"
main=$(grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' "$W/index.html" | head -1)
echo "Hauptbundle: $main"
get "$BASE$main" -o "$W/js/main.js"

# Vite listet alle Chunks im Hauptbundle auf
grep -oE 'assets/[A-Za-z0-9_.-]+\.js' "$W/js/main.js" | sort -u > "$W/chunks.txt"
echo "Chunks: $(wc -l < "$W/chunks.txt")"
export -f get; export BASE UA W
xargs -a "$W/chunks.txt" -P 8 -I{} bash -c 'get "$BASE/{}" -o "$W/js/$(basename {})" || true'
cat "$W"/js/*.js > "$W/all.js"
echo "JS gesamt: $(wc -c < "$W/all.js") Bytes"

{
  echo "== Zeichenketten mit /api/"
  grep -ohE "[\"'\`][^\"'\`[:space:]]{0,80}/api/[^\"'\`[:space:]]{0,100}[\"'\`]" "$W/all.js" | sort -u | head -400
  echo
  echo "== Pfade mit tournament/turnier/venue/event/calendar/competition"
  grep -ohE "[\"'\`][^\"'\`[:space:]]{0,80}(tournament|turnier|venue|calendar|competition)[^\"'\`[:space:]]{0,80}[\"'\`]" "$W/all.js" | grep -E '/' | sort -u | head -300
} > "$OUT/api-paths.txt"
wc -l "$OUT/api-paths.txt"
