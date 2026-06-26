#!/usr/bin/env bash
# Finalize a recorded Showcase take into the docs pipeline.
#   scripts/finalize-take.sh <emitted-slug> <dest-walkthrough-name>
# e.g. scripts/finalize-take.sh field-translator__editor-translate-cell editor-translate-cell
#
# - assembles the take (in the rec worktree),
# - stages the .mp4 + editlist in gitignored .video-staging/ (NOT the repo),
# - copies the small storyboard into docs/walkthroughs/<dest>/ (committed),
# - appends the R2 upload manifest,
# - prints chapter mm:ss offsets for CSV mapping.
set -euo pipefail

SLUG="${1:?emitted slug, e.g. field-translator__editor-translate-cell}"
DEST="${2:?dest walkthrough name, e.g. editor-translate-cell}"
MAIN="/Users/ryderwishart/prototypes/codex-web-app"
REC="/Users/ryderwishart/prototypes/codex-rec"
OUT="$REC/e2e/recordings/output"

cd "$REC"
npm run record:assemble -- --slug "$SLUG" >/dev/null 2>&1 || { echo "assemble failed for $SLUG"; exit 1; }
[ -f "$OUT/$SLUG.mp4" ] || { echo "no mp4 produced for $SLUG"; exit 1; }

mkdir -p "$MAIN/.video-staging/walkthroughs/$DEST" "$MAIN/docs/walkthroughs/$DEST"
cp "$OUT/$SLUG.mp4" "$MAIN/.video-staging/walkthroughs/$DEST/$DEST.mp4"
cp "$OUT/$SLUG.editlist.json" "$MAIN/.video-staging/walkthroughs/$DEST/$DEST.editlist.json"
cp "$OUT/$SLUG.storyboard.json" "$MAIN/docs/walkthroughs/$DEST/$DEST.storyboard.json"

R2KEY="aquilla-docs/walkthroughs/$DEST/$DEST.mp4"
MANIFEST="$MAIN/docs/walkthroughs/UPLOAD-MANIFEST.tsv"
grep -q "$R2KEY" "$MANIFEST" 2>/dev/null || \
  printf ".video-staging/walkthroughs/%s/%s.mp4\t%s\tpending-upload\n" "$DEST" "$DEST" "$R2KEY" >> "$MANIFEST"

echo "FINALIZED $DEST  (r2://$R2KEY)"
echo "chapters:"
python3 - "$MAIN/docs/walkthroughs/$DEST/$DEST.storyboard.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
for c in d.get("chapters",[]):
    ms=int(c.get("t") or c.get("time") or c.get("start") or 0)
    print(f'  {ms//60000:02d}:{(ms//1000)%60:02d}  {c.get("title") or c.get("caption") or ""}')
print("  duration_ms:", d.get("durationMs"))
PY
