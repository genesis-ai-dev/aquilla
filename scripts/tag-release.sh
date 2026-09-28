#!/usr/bin/env bash
# Tags the deployed HEAD of a release/YYYY/MM/DD[-NN] branch as YYYY.MM.DD.NN
# and pushes the tag. Run only after a verified production deploy.
# The date and first NN come from the branch (not today), so release/.../28-02
# is tagged 2026.09.28.02 and hotfixes stay in one series (next free NN).
# Re-deploying an already-tagged commit reuses its tag instead of bumping NN.
set -euo pipefail

branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || echo "${GITHUB_REF_NAME:-}")"
if ! [[ "$branch" =~ ^release/([0-9]{4})/([0-9]{2})/([0-9]{2})(-[0-9]{2})?$ ]]; then
  echo "ABORT: tag-release requires a release/YYYY/MM/DD branch (currently on '$branch')." >&2
  exit 1
fi
series="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}"
# The branch's own -NN suffix is the tag number a first deploy should claim, so
# release/2026/09/28-02 becomes 2026.09.28.02. A plain date branch claims 00.
branch_nn="${BASH_REMATCH[4]#-}"
want=$((10#${branch_nn:-0}))

# Tag only the commit production is serving. The deploy chain runs this
# straight after its live checks, but a later manual run may have a newer
# HEAD. Retries cover the seconds a fresh deploy can take to reach the edge.
version_url="${TAG_RELEASE_VERSION_URL:-https://aquilla.app/version.json}"
retry_seconds="${TAG_RELEASE_VERSION_RETRY_SECONDS:-10}"
head_sha="$(git rev-parse HEAD)"
live_sha=""
for check in 1 2 3 4 5 6; do
  live_sha="$(curl -fsS --max-time 10 -H "Cache-Control: no-cache" "$version_url" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).sha??""))}catch{}})' \
    || true)"
  if [[ "$live_sha" =~ ^[0-9a-f]{7,40}$ && "$head_sha" == "$live_sha"* ]]; then
    break
  fi
  [ "$check" -lt 6 ] && sleep "$retry_seconds"
done
if ! [[ "$live_sha" =~ ^[0-9a-f]{7,40}$ && "$head_sha" == "$live_sha"* ]]; then
  echo "ABORT: $version_url reports '${live_sha:-nothing}', but HEAD is ${head_sha:0:9}. Tag the commit production is serving." >&2
  exit 1
fi

# The "release tags" ruleset requires a successful GitHub Deployment against
# `production` before it accepts the tag push below. Nothing else in the
# deploy chain records one, so do it here, once, before any push attempt.
script_dir="$(cd "$(dirname "$0")" && pwd)"
if [ -z "${GITHUB_TOKEN:-}" ] && command -v gh >/dev/null 2>&1; then
  GITHUB_TOKEN="$(gh auth token 2>/dev/null || true)" # secret-scan:allow — command substitution, not a literal secret
  export GITHUB_TOKEN
fi
if [ -z "${GITHUB_TOKEN:-}" ]; then
  echo "ABORT: GITHUB_TOKEN is required (and 'gh auth token' found none) to record the production deployment." >&2
  exit 1
fi
# Tests point TAG_RELEASE_RECORD_DEPLOYMENT at a stub so they never write to
# the real repo. The ruleset still checks GitHub, so a stub can't fake a tag.
record_deployment="${TAG_RELEASE_RECORD_DEPLOYMENT:-$script_dir/record-github-deployment.mjs}"
node "$record_deployment" "$(git rev-parse HEAD)" production

for attempt in 1 2 3; do
  # Fetch tags only: a full fetch can trip over unrelated broken remote refs.
  git fetch --quiet origin "refs/tags/$series.*:refs/tags/$series.*"

  existing="$(git tag --points-at HEAD --list "$series.*" | sort -V | tail -1)"
  if [ -n "$existing" ]; then
    echo "OK: HEAD is already tagged $existing; not creating a new release number."
    exit 0
  fi

  last="$(git tag --list "$series.*" | sort -V | tail -1)"
  next=$want
  if [ -n "$last" ] && [ $((10#${last##*.} + 1)) -gt "$want" ]; then
    # The branch's number is taken (hotfix, re-cut) or behind: go one past the highest.
    next=$((10#${last##*.} + 1))
  fi
  tag="$series.$(printf '%02d' "$next")"
  commit_sha="$(git rev-parse HEAD)"

  # Generate annotated tag message with preview metadata
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
  if push_output="$(git push --quiet origin "refs/tags/$tag" 2>&1)"; then
    echo "OK: tagged and pushed $tag."
    exit 0
  fi
  git tag -d "$tag" >/dev/null

  # A ruleset rejection (GH013) fails the same way on every attempt, so a
  # retry would only report it as a number clash three times.
  if grep -q "GH013" <<<"$push_output"; then
    echo "$push_output" >&2
    echo "ABORT: GitHub's rules rejected $tag; no other deploy has claimed it. Check the rule named above." >&2
    exit 1
  fi

  # Someone else claimed this number between fetch and push; retry with the next one.
  echo "$push_output" >&2
  echo "WARN: pushing $tag failed (attempt $attempt); retrying in case another deploy claimed it." >&2
done

echo "ABORT: could not claim a release tag for $series after 3 attempts." >&2
exit 1
