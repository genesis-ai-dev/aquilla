#!/usr/bin/env bash
# Audit a base-into-branch merge for the breaks git does not mark as conflicts.
#
#   merge-audit.sh [merge-commit]      (default: HEAD)
#
# Run from the worktree. While a merge is still in progress (MERGE_HEAD exists)
# it audits the working tree instead, so it works before and after the commit.
#
# Reports:
#   1. Files BOTH sides changed - the only places an auto-merge can land a hunk
#      somewhere it no longer belongs - and whether the branch's added/removed
#      lines survived the merge unchanged.
#   2. Changes outside the overlap: files only the branch changed whose diff
#      moved, and files the branch never touched that now differ from the base
#      (only your own deliberate follow-up edits should appear).
#   3. The PR's effective diff against the base after the merge.
#   4. Migration filename collisions and copies of migrations the base already has.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if git rev-parse -q --verify MERGE_HEAD >/dev/null; then
  ours="$(git rev-parse HEAD)"
  theirs="$(git rev-parse MERGE_HEAD)"
  merged=""
  echo "Auditing the in-progress merge (working tree)"
else
  m="${1:-HEAD}"
  set -- $(git rev-list --parents -n 1 "$m")
  if [ $# -ne 3 ]; then
    echo "$m is not a two-parent merge commit." >&2
    exit 2
  fi
  merged="$1"
  ours="$2"
  theirs="$3"
  echo "Auditing merge $(git rev-parse --short "$merged")"
fi

bases="$(git merge-base --all "$ours" "$theirs")"
base="$(printf '%s\n' "$bases" | head -n 1)"
echo "  branch tip $(git rev-parse --short "$ours")   base tip $(git rev-parse --short "$theirs")   merge-base $(git rev-parse --short "$base")"
if [ "$(printf '%s\n' "$bases" | wc -l | tr -d ' ')" -gt 1 ]; then
  echo "  NOTE: several merge bases (criss-cross history) - line comparisons below are approximate."
fi
echo

# Added/removed lines of a diff, order-independent, without file headers.
sig() { grep -E '^[+-]' | grep -vE '^(\+\+\+|---) (a/|b/|/dev/null)' | LC_ALL=C sort || true; }

# --text: a few source files here contain raw NUL bytes and would diff as binary.
branch_diff() { git diff --text --no-renames -U0 "$base" "$ours" -- "$1"; }
merged_diff() {
  if [ -n "$merged" ]; then
    git diff --text --no-renames -U0 "$theirs" "$merged" -- "$1"
  else
    git diff --text --no-renames -U0 "$theirs" -- "$1"
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git diff --no-renames --name-only "$base" "$ours" | LC_ALL=C sort >"$tmp/branch"
git diff --no-renames --name-only "$base" "$theirs" | LC_ALL=C sort >"$tmp/base"
comm -12 "$tmp/branch" "$tmp/base" >"$tmp/both"

both_count="$(wc -l <"$tmp/both" | tr -d ' ')"
branch_count="$(wc -l <"$tmp/branch" | tr -d ' ')"

echo "== 1. Files both sides changed: $both_count of the branch's $branch_count =="
if [ "$both_count" -eq 0 ]; then
  echo "  none - the two sides are disjoint, slippage is impossible."
fi
: >"$tmp/branch_only_drift"
while IFS= read -r f; do
  [ -n "$f" ] || continue
  branch_diff "$f" | sig >"$tmp/orig"
  merged_diff "$f" | sig >"$tmp/now"
  lost="$(comm -23 "$tmp/orig" "$tmp/now" | wc -l | tr -d ' ')"
  gained="$(comm -13 "$tmp/orig" "$tmp/now" | wc -l | tr -d ' ')"
  if grep -qxF "$f" "$tmp/both"; then
    if [ "$lost" -eq 0 ] && [ "$gained" -eq 0 ]; then
      echo "  same lines      $f"
    else
      echo "  LINES CHANGED   $f   ($lost of the branch's lines gone, $gained new)"
    fi
  elif [ "$lost" -ne 0 ] || [ "$gained" -ne 0 ]; then
    echo "  $f   ($lost gone, $gained new)" >>"$tmp/branch_only_drift"
  fi
done <"$tmp/branch"
if [ "$both_count" -gt 0 ]; then
  echo
  echo "  'same lines' proves nothing was dropped - NOT that each hunk sits at the right site."
  if [ -n "$merged" ]; then
    echo "  Read every file above:  git diff -U8 $(git rev-parse --short "$theirs") $(git rev-parse --short "$merged") -- <file>"
  else
    echo "  Read every file above:  git diff -U8 MERGE_HEAD -- <file>"
  fi
fi
echo

echo "== 2. Changes outside the two sides' overlap (expect only your own deliberate edits) =="
# Files the branch never touched that nonetheless differ from the base: edits
# made to the base's own files while resolving (docs, tests, callers).
if [ -n "$merged" ]; then
  git diff --no-renames --name-only "$theirs" "$merged" | LC_ALL=C sort >"$tmp/effective"
else
  git diff --no-renames --name-only "$theirs" | LC_ALL=C sort >"$tmp/effective"
fi
comm -23 "$tmp/effective" "$tmp/branch" | sed 's/$/   (the branch never touched this file)/; s/^/  /' >"$tmp/foreign"
if [ -s "$tmp/branch_only_drift" ] || [ -s "$tmp/foreign" ]; then
  cat "$tmp/branch_only_drift" "$tmp/foreign"
else
  echo "  none"
fi
echo

echo "== 3. Effective PR diff against the base after the merge =="
if [ -n "$merged" ]; then
  stat="$(git diff --shortstat "$theirs" "$merged")"
else
  stat="$(git diff --shortstat "$theirs")"
fi
if [ -n "$stat" ]; then
  echo " $stat"
else
  echo "  EMPTY - the base already contains everything this PR changes. Superseded? Stop and report."
fi
echo

echo "== 4. Migrations =="
mig_dir="db/postgres/migrations"
if [ -n "$merged" ]; then
  added="$(git diff --no-renames --name-only --diff-filter=A "$theirs" "$merged" -- "$mig_dir")"
else
  added="$(git diff --no-renames --name-only --diff-filter=A "$theirs" -- "$mig_dir")"
fi
if [ -z "$added" ]; then
  echo "  the branch adds none"
else
  git ls-tree -r --name-only "$theirs" -- "$mig_dir" >"$tmp/base_migs"
  base_max="$(sed 's|.*/||' "$tmp/base_migs" | grep -E '^[0-9]+_' | LC_ALL=C sort | tail -n 1)"
  echo "  base's latest: $base_max"
  body() { grep -vE '^[[:space:]]*(--|$)' | git hash-object --stdin; }
  printf '%s\n' "$added" | while IFS= read -r f; do
    name="${f##*/}"
    prefix="${name%%_*}"
    if [ -n "$merged" ]; then
      mine="$(git show "$merged:$f" | body)"
    else
      mine="$(body <"$f")"
    fi
    twin=""
    while IFS= read -r b; do
      if [ "$(git show "$theirs:$b" | body)" = "$mine" ]; then
        twin="${b##*/}"
        break
      fi
    done <"$tmp/base_migs"
    clash="$(sed 's|.*/||' "$tmp/base_migs" | grep -E "^${prefix}_" | tr '\n' ' ' || true)"
    if [ -n "$twin" ]; then
      echo "  $name   DUPLICATE of the base's $twin (same SQL) -> git rm it, do not renumber"
    elif [ -n "$clash" ]; then
      echo "  $name   PREFIX COLLISION with the base's $clash-> renumber past $base_max"
    elif [ "$prefix" \< "${base_max%%_*}" ]; then
      echo "  $name   sorts BEFORE the base's latest -> renumber past $base_max"
    else
      echo "  $name   ok"
    fi
  done
fi
