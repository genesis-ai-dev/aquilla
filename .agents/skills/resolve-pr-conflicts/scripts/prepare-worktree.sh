#!/usr/bin/env bash
# Create a detached scratch worktree at a PR's head and preview what merging its
# base branch will involve. Touches no local branch and nothing on the remote.
#
#   prepare-worktree.sh <pr-number> <worktree-dir>
#
# Prints HEAD_BRANCH / BASE_BRANCH / OLD_TIP / BASE_TIP for the later steps.
set -euo pipefail

[ $# -eq 2 ] || { echo "usage: $0 <pr-number> <worktree-dir>" >&2; exit 2; }
pr="$1"
wt="$2"

common="$(git rev-parse --path-format=absolute --git-common-dir)"
main="$(dirname "$common")"

info="$(cd "$main" && gh pr view "$pr" \
  --json state,isCrossRepository,headRefName,baseRefName,url,title \
  -q '[.state, (.isCrossRepository|tostring), .headRefName, .baseRefName, .url, .title] | @tsv')"
IFS=$'\t' read -r state cross head base url title <<<"$info"

if [ "$state" != "OPEN" ]; then
  echo "PR #$pr is $state - nothing to resolve." >&2
  exit 1
fi
if [ "$cross" != "false" ]; then
  echo "PR #$pr comes from a fork; this flow pushes to origin and cannot update it. Stop and ask." >&2
  exit 1
fi
if [ -e "$wt" ]; then
  echo "$wt already exists - pick another directory or remove it first." >&2
  exit 1
fi

git -C "$main" fetch --quiet origin "$head" "$base"

# Someone else may be mid-work on this branch; a push from here would diverge them.
elsewhere="$(git -C "$main" worktree list --porcelain \
  | awk -v b="refs/heads/$head" '/^worktree /{w=substr($0,10)} $1=="branch" && $2==b {print w}')"
if [ -n "$elsewhere" ]; then
  echo "WARNING: $head is checked out in another worktree: $elsewhere"
  echo "         Check it for uncommitted or unpushed work before pushing from here."
fi
if git -C "$main" rev-parse -q --verify "refs/heads/$head" >/dev/null; then
  unpushed="$(git -C "$main" rev-list --count "origin/$head..refs/heads/$head")"
  if [ "$unpushed" -gt 0 ]; then
    echo "WARNING: local branch $head has $unpushed commit(s) that are not on origin."
    echo "         They are NOT in this worktree (it starts from origin/$head)."
  fi
fi

git -C "$main" worktree add --quiet --detach "$wt" "origin/$head"

old_tip="$(git -C "$wt" rev-parse HEAD)"
base_tip="$(git -C "$wt" rev-parse "origin/$base")"
merge_base="$(git -C "$wt" merge-base HEAD "origin/$base")"
ahead="$(git -C "$wt" rev-list --count "origin/$base..HEAD")"
behind="$(git -C "$wt" rev-list --count "HEAD..origin/$base")"

echo
echo "PR #$pr  $title"
echo "$url"
echo "  $head ($ahead ahead) <- $base ($behind behind)"
echo

# Dry-run the merge in memory (git >= 2.38) so the conflict list is known up front.
if preview="$(git -C "$wt" merge-tree --write-tree --name-only HEAD "origin/$base" 2>/dev/null)"; then
  echo "Preview: merges cleanly (no textual conflicts). Still audit and verify."
else
  conflicted="$(printf '%s\n' "$preview" | sed -n '2,/^$/p' | sed '/^$/d')"
  if [ -n "$conflicted" ]; then
    echo "Preview: conflicts expected in"
    printf '%s\n' "$conflicted" | sed 's/^/  /'
  else
    echo "Preview unavailable (old git?) - run the merge to see conflicts."
  fi
fi

echo
echo "WORKTREE=$wt"
echo "HEAD_BRANCH=$head"
echo "BASE_BRANCH=$base"
echo "OLD_TIP=$old_tip"
echo "BASE_TIP=$base_tip"
echo "MERGE_BASE=$merge_base"
