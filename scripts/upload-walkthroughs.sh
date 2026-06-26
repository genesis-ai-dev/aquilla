#!/usr/bin/env bash
# Publish the staged walkthrough videos to the aquilla-docs R2 bucket
# (served at https://docs.aquilla.app/walkthroughs/<slug>/<slug>.mp4).
#
# Uploads every .video-staging/walkthroughs/<slug>/<slug>.mp4 to the matching
# R2 key, EXCEPT org-setup (already live as org-setup-create-and-settings.mp4).
# Idempotent — re-running overwrites. Requires `wrangler login` to the Frontier
# R&D Cloudflare account.
#
#   bash scripts/upload-walkthroughs.sh            # upload all pending
#   bash scripts/upload-walkthroughs.sh --dry-run  # print what would upload
set -euo pipefail

ACCOUNT="6a80496d1e59948a9cbaa3c643ba81d7"   # Frontier R&D
BUCKET="aquilla-docs"
STAGE="$(cd "$(dirname "$0")/.." && pwd)/.video-staging/walkthroughs"
DRY="${1:-}"

count=0
for mp4 in "$STAGE"/*/*.mp4; do
  slug="$(basename "$(dirname "$mp4")")"
  [ "$slug" = "org-setup" ] && continue   # already published under its real name
  key="$BUCKET/walkthroughs/$slug/$slug.mp4"
  if [ "$DRY" = "--dry-run" ]; then
    echo "would upload: $mp4 -> $key"
  else
    echo "uploading $slug ..."
    CLOUDFLARE_ACCOUNT_ID="$ACCOUNT" npx wrangler r2 object put "$key" \
      --file="$mp4" --content-type=video/mp4 --remote
  fi
  count=$((count+1))
done
echo "done: $count video(s) ($([ "$DRY" = "--dry-run" ] && echo 'dry-run' || echo 'uploaded'))."
echo "verify: curl -sI https://docs.aquilla.app/walkthroughs/project-tour/project-tour.mp4"
