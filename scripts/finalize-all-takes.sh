#!/usr/bin/env bash
# Finalize ALL 22 re-recorded doc takes from a SINGLE record run (all 22 .webm
# present in output/). For each take, pass its OWN video.webm to the assembler —
# matched by spec filename — because assemble's default recency-pairing would
# give every take the most-recent .webm (they'd all be identical).
# Columns: emitted-slug  dest-walkthrough-slug  spec-file-basename
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="/Users/ryderwishart/prototypes/codex-rec/e2e/recordings/output"

MAP=$(cat <<'EOF'
demo-org-admin__create-org-and-settings  org-setup                  org-create-settings-doc
demo-curated__documentation-walkthrough  project-tour               demo-curated-doc
field-translator__editor-translate-cell  editor-translate-cell      editor-translate-cell-doc
consultant__validation-validate-cell     validation-validate-cell   validation-validate-cell-doc
translator__terminology                  terminology-confirm-terms  terminology-doc
collaborator__comments                   comments-discuss           comments-doc
translator__living-memory                living-memory              living-memory-doc
project-lead__project-settings           project-settings           project-settings-doc
project-lead__projects-dashboard         projects-dashboard         projects-dashboard-doc
org-admin__teams-and-members             teams-invite-members       teams-doc
project-manager__project-overview        overview-read-progress     project-overview-doc
org-admin__org-settings                  settings-org               org-settings-doc
translator__search-find-replace          search-find-replace        search-doc
translator__export-usfm-docx             export-usfm-docx           export-doc
project-lead__sharing-invites            sharing-invite-link        sharing-doc
translator__ai-autodraft-cell            ai-autodraft-cell          ai-completions-doc
new-user__onboarding                     onboarding-first-run       onboarding-doc
collaborator__sync-collaboration         collab-realtime            sync-collab-doc
admin__admin-debug                       admin-debug-tools          admin-debug-doc
project-lead__import                     import-usfm-paratext       import-doc
project-lead__rules-checks               rules-run-checks           rules-doc
translator__audio-voice                  audio-voice-tts            voice-doc
EOF
)

ok=0; fail=0
while read -r emitted dest spec; do
  [ -z "$emitted" ] && continue
  [ -f "$OUT/$emitted.storyboard.json" ] || { echo "SKIP (no storyboard): $dest"; continue; }
  # The Playwright video dir starts with a TRUNCATED "<spec>.showcase.ts" (long
  # spec names get cut), so match on the first 18 chars of the spec name — always
  # preserved, and unique across all 22 specs.
  webm=$(ls -dt "$OUT/${spec:0:18}"*chromium 2>/dev/null | head -1)/video.webm
  if [ ! -f "$webm" ]; then echo "SKIP (no video for $spec): $dest"; continue; fi
  bash "$HERE/finalize-take.sh" "$emitted" "$dest" "$webm" </dev/null && ok=$((ok+1)) || { echo "FAILED: $dest"; fail=$((fail+1)); }
done <<< "$MAP"
echo "=== finalized $ok, failed $fail ==="
