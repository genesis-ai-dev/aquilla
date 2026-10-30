#!/bin/sh
# get_fonts.sh <film folder>: download the three open-licence (SIL OFL) variable fonts the engine uses.
# Archivo (display type, weight and width axes), JetBrains Mono (code and HUD), Instrument Sans (captions).
set -e
D="${1:-.}/fonts"; mkdir -p "$D"
G=https://github.com/google/fonts/raw/main/ofl
get() { [ -s "$D/$2" ] || curl -fsSL "$G/$1" -o "$D/$2"; }
get 'archivo/Archivo%5Bwdth,wght%5D.ttf' Archivo.ttf
get 'jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf' JetBrainsMono.ttf
get 'instrumentsans/InstrumentSans%5Bwdth,wght%5D.ttf' InstrumentSans.ttf
ls -l "$D"
