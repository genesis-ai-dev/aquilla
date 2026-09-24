#!/usr/bin/env bash
# Tags the deployed HEAD of a release/YYYY/MM/DD branch as YYYY.MM.DD.NN and
# pushes the tag. Run only after a verified production deploy.
# The date comes from the branch (not today), so hotfixes stay in one series.
# Re-deploying an already-tagged commit reuses its tag instead of bumping NN.
set -euo pipefail

branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo "${GITHUB_REF_NAME:-}")"
if ! [[ "$branch" =~ ^release/([0-9]{4})/([0-9]{2})/([0-9]{2})$ ]]; then
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

  git tag -a "$tag" -m "Production release $tag ($branch)"
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
