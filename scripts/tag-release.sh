#!/usr/bin/env bash
# Tags the deployed HEAD of a release/YYYY/MM/DD branch as YYYY.MM.DD.NN and
# pushes the tag. Run only after a verified production deploy.
# The date comes from the branch (not today), so hotfixes stay in one series.
# Re-deploying an already-tagged commit reuses its tag instead of bumping NN.
set -euo pipefail

branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo "${GITHUB_REF_NAME:-}")"
if ! [[ "$branch" =~ ^release/([0-9]{4})/([0-9]{2})/([0-9]{2})(-[0-9]{2})?$ ]]; then
  echo "ABORT: tag-release requires a release/YYYY/MM/DD branch (currently on '$branch')." >&2
  exit 1
fi
series="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}"

for attempt in 1 2 3; do
  # Fetch tags only: a full fetch can trip over unrelated broken remote refs.
  git fetch --quiet origin "refs/tags/$series.*:refs/tags/$series.*"

  existing="$(git tag --points-at HEAD --list "$series.*" | sort -V | tail -1)"
  if [ -n "$existing" ]; then
    echo "OK: HEAD is already tagged $existing; not creating a new release number."
    exit 0
  fi

  last="$(git tag --list "$series.*" | sort -V | tail -1)"
  next=0
  if [ -n "$last" ]; then
    next=$((10#${last##*.} + 1))
  fi
  tag="$series.$(printf '%02d' "$next")"
  commit_sha="$(git rev-parse HEAD)"

  # Generate annotated tag message with preview metadata
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  metadata_script="$script_dir/tag-metadata.mjs"
  
  # Find node executable (try PATH first, then common locations)
  node_cmd="node"
  if ! command -v node >/dev/null 2>&1; then
    for candidate in /exec-daemon/node /usr/local/bin/node /usr/bin/node; do
      if [ -x "$candidate" ]; then
        node_cmd="$candidate"
        break
      fi
    done
  fi
  
  if [ ! -f "$metadata_script" ]; then
    echo "WARN: tag-metadata.mjs not found at $metadata_script; using minimal tag message." >&2
    tag_message="Production release $tag ($branch)"
  elif ! command -v "$node_cmd" >/dev/null 2>&1; then
    echo "WARN: node executable not found; using minimal tag message." >&2
    tag_message="Production release $tag ($branch)"
  elif tag_message_output="$("$node_cmd" "$metadata_script" "$tag" "$branch" "$commit_sha" 2>&1)"; then
    tag_message="$tag_message_output"
  else
    # Fallback to minimal message if metadata generation fails
    echo "WARN: metadata generation failed: $tag_message_output; using minimal tag message." >&2
    tag_message="Production release $tag ($branch)"
  fi

  git tag -a "$tag" -m "$tag_message"
  if git push --quiet origin "refs/tags/$tag"; then
    echo "OK: tagged and pushed $tag."
    exit 0
  fi

  # Someone else claimed this number between fetch and push; retry with the next one.
  git tag -d "$tag" >/dev/null
  echo "WARN: $tag was taken on origin (attempt $attempt); retrying." >&2
done

echo "ABORT: could not claim a release tag for $series after 3 attempts." >&2
exit 1
