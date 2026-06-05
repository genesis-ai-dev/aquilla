---
description: Work a Linear issue from Todo → Dispatched → Fixed (→ Ready for Review with --deploy)
argument-hint: <FRO-NNN> [--deploy]
---

You are the autonomous issue-fix agent for codex-web-prototype. Follow every step in order; do not skip verification gates.

Arguments: $ARGUMENTS

---

## Status pipeline

Backlog → **Todo** → **Dispatched** → **Fixed** → Ready for Review → Ready for QA → Deployed

This command drives an issue from Todo through to Fixed. Pass `--deploy` to also push a staging deploy and advance to Ready for Review.

---

## Steps

### 1. Parse arguments

Split `$ARGUMENTS` into `<issueId>` (e.g. `FRO-42`) and the optional `--deploy` flag.

### 2. Claim the issue

Via the Linear MCP:
- `get_issue <issueId>` — read the full description, acceptance criteria, and `gitBranchName`.
- `save_issue <issueId> state=Dispatched assignee=me` — claim it immediately.

If the issue is already Dispatched or beyond, **stop** and report — another run owns it.

### 3. Set up the branch

```bash
git fetch origin
git checkout -b <gitBranchName> origin/dev 2>/dev/null || git checkout <gitBranchName>
```

### 4. Understand and fix

- Read every file touched by the issue description before editing.
- Make the minimal surgical change that satisfies the acceptance criteria.
- Do NOT refactor surrounding code, add unrelated features, or invent requirements not in the issue.
- Do NOT touch `src/components/ProjectCreateDialog.tsx` if it has uncommitted/conflicting changes — report and stop.

### 5. Verify

Run all three gates (never skip):

```bash
npx tsc -b --noEmit
npx vitest run
```

If the issue touched `auth-worker/`:
```bash
cd auth-worker && npm test && cd ..
```

If the issue touched `sync-worker/`:
```bash
cd sync-worker && npm test && cd ..
```

If the issue touched `chat-worker/`:
```bash
cd chat-worker && npm test && cd ..
```

All gates must pass. If any fail, fix and re-run. Do NOT proceed to commit with a failing gate.

### 6. Commit

```bash
git add <changed files — be specific, never `git add -A`>
git commit -m "fix: <one-line summary> (FRO-NNN)"
```

The commit message must reference the issue ID.

### 7. Reconcile the spec (aquilla-specs repo)

Open `../aquilla-specs/` and follow `PLAN.md` for the current extraction pass.

Add or adjust a **regression-guard acceptance criterion** in the relevant spec section that describes the corrected behaviour. If no spec section covers this area, add one under the closest heading.

```bash
cd ../aquilla-specs
git add <changed spec files>
git commit -m "spec: regression guard for FRO-NNN — <one-line>"
cd ../codex-web-prototype
```

If no spec change is needed (e.g. the fix is pure infrastructure with no user-visible behaviour), post a Linear comment explaining which spec section you checked and why no change was required.

### 8. Push and open a PR

```bash
git push -u origin <gitBranchName>
```

Open a PR against `dev` (not `main`). Title: `fix: <one-line summary> (FRO-NNN)`.

### 9. Move to Fixed and comment

Via Linear MCP:
- `save_issue <issueId> state=Fixed`
- `save_comment <issueId>` — post a comment with:
  - What the root cause was.
  - What was changed and in which files.
  - Exact verification output (tsc clean, vitest pass, worker tests if run).
  - Link to the PR.
  - Whether a spec change was made or skipped (and why).

**Stop here unless `--deploy` was passed.**

---

### 10. Staging deploy (only with `--deploy`)

```bash
npm run deploy:staging
```

This builds the SPA with staging worker URLs and deploys to the `staging` branch of the `codex-web` Cloudflare Pages project. The staging environment lives at:

- **SPA**: `https://staging.codex-web-4ih.pages.dev` (or `https://dev.aquilla.app` once the custom domain is wired)
- **Auth worker**: `https://codex-auth-worker-staging.blue-darkness-7674.workers.dev`
- **Sync worker**: `codex-sync-worker-staging.blue-darkness-7674.workers.dev`
- **Chat worker**: `https://codex-chat-worker-staging.blue-darkness-7674.workers.dev`

Workers are deployed automatically by CI on push to the `dev` branch (`deploy-workers.yml`).

#### Staging safety checklist

Before marking Ready for Review, confirm:
- [ ] `WRANGLER_LOCAL` is NOT set on any staging worker (the `/__test__/reset` endpoint returns 404 on staging — correct behaviour).
- [ ] `ALLOW_UNAUTHENTICATED` is NOT set to `"true"` on the staging sync-worker.
- [ ] The fix is visible / the bug is absent on the staging URL.

### 11. Move to Ready for Review (only with `--deploy`)

Via Linear MCP:
- `save_issue <issueId> state=Ready for Review`
- Update the Linear comment with the staging URL and confirmation the checklist above passed.

---

## Constraints

- Only work issues that were **Todo** at the start of the run. Anything already Dispatched is owned by another run.
- Never force-push or rewrite `main` or `dev`.
- Never bypass pre-push hooks (`--no-verify`).
- Never claim Fixed if any verification gate was skipped.
- If you cannot finish, leave the issue in **Dispatched** and post a Linear comment with exactly where you got to, so the next run resumes rather than restarts.
