#!/bin/sh
# new_film.sh <folder> [example]: start a film folder: the engine, an example spec to edit, fonts, an audio folder.
# Examples live in ../examples (starter = a short template, just-code = the full 52 s film).
set -e
H=$(cd "$(dirname "$0")/.." && pwd); D="$1"; X="${2:-starter}"
[ -n "$D" ] || { echo "usage: new_film.sh <folder> [example]"; exit 1; }
mkdir -p "$D/audio"
for f in "$H"/engine/*; do [ -f "$f" ] && cp "$f" "$D"/; done
mkdir -p "$D/fonts" && cp "$H"/engine/fonts/* "$D/fonts/" 2>/dev/null || true
for f in "$H/examples/$X/"*; do [ -e "$D/$(basename "$f")" ] || cp "$f" "$D"/; done
[ -s "$D/fonts/Archivo.ttf" ] || sh "$H/scripts/get_fonts.sh" "$D" > /dev/null   # fonts ship in engine/fonts; fetch only if missing
echo "film folder ready: $D (edit spec.js, then preview with: cd $D && python3 -m http.server 5671)"
