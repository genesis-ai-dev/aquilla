#!/usr/bin/env bash
# One-time setup: put `startaq`, `refresh`, and `stopaq` on your PATH.
#
#   ./scripts/install-aq-commands.sh
#
# Then open a new terminal (or `source ~/.zshrc`) and run:
#   startaq

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/scripts/bin"
MARKER="# Aquilla local dev commands (startaq / refresh)"
ZSHRC="${ZSHRC:-$HOME/.zshrc}"
PATH_LINE="export PATH=\"$BIN_DIR:\$PATH\""

chmod +x "$BIN_DIR"/startaq "$BIN_DIR"/refresh "$BIN_DIR"/stopaq "$ROOT/scripts/dev-ctl.sh"

if [[ -f "$ZSHRC" ]] && grep -q "$MARKER" "$ZSHRC" 2>/dev/null; then
  echo "Already installed in $ZSHRC"
else
  {
    echo ""
    echo "$MARKER"
    echo "$PATH_LINE"
  } >>"$ZSHRC"
  echo "Appended to $ZSHRC:"
  echo "  $PATH_LINE"
fi

echo ""
echo "Next steps:"
echo "  1. source ~/.zshrc   (or open a new terminal tab)"
echo "  2. startaq           (starts watchdog + dev stack)"
echo ""
echo "While working:"
echo "  refresh   restart servers if something breaks (then Cmd+R in the browser)"
echo "  stopaq    stop watchdog + dev stack when you're done"
