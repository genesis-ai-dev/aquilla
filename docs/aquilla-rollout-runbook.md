# Aquilla Rollout Runbook

Status reference + playbooks for finishing the codex-web → Aquilla spec alignment effort. Tracks **what's done**, **what's in flight**, **what's deferred**, and the exact mechanical playbooks for the two cleanup phases that wait on the in-flight work.

Reflects state as of the Phase 2c-β / Phase 3 work stream.

## Phase ledger

| Phase | Deliverable | Status | PR / Branch |
|---|---|---|---|
| 1A | events + cells schema reshape (AD-2 + AD-9) | ✅ merged | #79 |
| 1B | monorepo skeleton (AD-11) | ✅ merged | #77 |
| 1C | project_settings + source-project routes | ✅ merged | #78 |
| 2a | sync-worker read routes + useCells migration | ✅ merged | #80 |
| 2b | rewire remaining read-side hooks | ✅ merged | #81 |
| 2c-α | outbox emitters + per-project DO + WS reconciler + useFocusLock | ✅ merged | #82 |
| 2c-β | plain TipTap + import rewrite + Yjs removal | 🟡 in flight | subagent |
| 3a-shell | apps/workspace/ Vite + tsconfig scaffolding | ✅ merged | #84 |
| 3a-final | move src/ → apps/workspace/src/ + rewrite imports | ⏸ blocked | see playbook |
| 3b | login/signup/reset apps + packages/ui + packages/auth-client | 🟡 in flight | subagent |
| 3c | projects/billing/org apps + packages/api-client | 🟡 in flight | subagent |
| 3d (minimal) | import/export/migrate app shells (Coming soon) | 🟡 in flight | subagent |
| 3e | auth-worker → apps/identity relocation | 🟡 in flight | subagent |
| 4 partial | codex-sync/chat-worker + codex-snapshots → aquilla-* | ✅ merged | #83 |
| 4 final-sweep partial | completion-service.ts aquilla-chat-worker rename | ✅ merged | #84 |
| 4 final-cleanup | residual codex-* refs in CLAUDE.md + src/ + auth-worker | ⏸ blocked | see playbook |
| 5 | AD-9 source-project linking UI + stale-source indicator | 🟡 in flight | subagent |
| packages/data-model | shared TS types | ✅ merged (in #85) |
| packages/telemetry | TelemetryClient interface + factories | ✅ merged (in #85) |

## Merge order once all in-flight PRs return

Conflict density is highest among Phase 3 streams + 2c-β because each touches `src/` and `CLAUDE.md`. Recommended order:

1. **Phase 2c-β first.** Largest surface area; touches the most files. Resolves the Yjs deletion + editor rewrite that everything else builds on top of.
2. **3e next.** Independent directory (auth-worker → apps/identity). Conflicts: only `CLAUDE.md` backend stack section and CI workflows. Resolve those manually.
3. **Phase 5 next.** Adds new components in `src/components/`; depends on 2c-β's editor surface for the stale-source indicator wiring. The indicator is shipped as a standalone component; wiring it into the cell row is the small follow-up step (see "Phase 5 follow-up" below).
4. **3b, 3c, 3d-minimal — parallel.** Each touches different `apps/<slug>/` directories. Conflicts: `packages/ui` if 3b and 3c both populate (likely they coordinated by scope — 3b for auth UI primitives, 3c for project/list primitives). `CLAUDE.md` "Apps populated" lines need a merge sweep.
5. **PR #85 (data-model + telemetry) — any time.** No code-edit conflicts; only adds new packages.

## Phase 3a-final playbook

Runs after Phase 2c-β + 3b + 3c + Phase 5 merge. Mechanical extraction.

### Prerequisites

- ✅ 2c-β merged (so `src/` no longer contains Yjs / partyserver-provider / cqrs-bridge / file-doc, and the editor is plain TipTap).
- ✅ 3b merged (so `packages/auth-client` + `packages/ui` are real, not stubs).
- ✅ 3c merged (so `packages/api-client` is real, and Dashboard/ProjectSettings/MembersPage have been copied into apps/projects + apps/org).
- ✅ Phase 5 merged (so the source-linking UI components exist in `src/components/`).

### Steps

```bash
# 1. New branch off dev.
git fetch origin && git checkout -B phase-3a-final/extract-workspace-spa origin/dev

# 2. Move src/ into apps/workspace/src/. Use git mv to preserve history.
mkdir -p apps/workspace
git mv src apps/workspace/src

# 3. Wire apps/workspace/index.html to point at the new entrypoint.
cat > apps/workspace/index.html <<'EOF'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <base href="/w/" />
    <title>Aquilla Workspace</title>
  </head>
  <body class="bg-background text-foreground">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
EOF

# 4. Strip routes from apps/workspace/src/App.tsx that are now in other apps.
# Routes to remove (now live in apps/projects):
#   /, /onboarding, /join/:token, /project/:id/settings, /settings
# Routes to remove (now live in apps/org):
#   /members, /settings/org (redirect can stay as 301)
# Routes to remove (now live in apps/billing):
#   none in v1 — billing is `later` per spec
# Routes to keep:
#   /project/:id, /project/:id/file/:fileId, /project/:id/{rules,memory,comments,snapshots,debug}
#   /debug

# 5. Rewire imports from src-local to @aquilla/* workspace packages:
#   sed -i 's|from "@/components/ui/|from "@aquilla/ui"|g' apps/workspace/src/**/*.tsx
#   sed -i 's|from "@/lib/sync/cells-read"|from "@aquilla/api-client"|g' ...
#   etc. Audit by hand — there will be edge cases.

# 6. Restore apps/workspace/package.json deps (stripped in 3a-shell to fix
#    --frozen-lockfile). Re-add the dependencies the SPA needs:
#    react, react-dom, react-router-dom, vite, @vitejs/plugin-react,
#    tailwindcss, @tailwindcss/vite, yjs ← NO (2c-β removed),
#    @aquilla/ui, @aquilla/auth-client, @aquilla/api-client, @aquilla/data-model,
#    @aquilla/errors, @aquilla/telemetry,
#    tiptap, @tiptap/starter-kit, etc.

# 7. Update pnpm-lock.yaml.
pnpm install

# 8. Run tests + build.
cd apps/workspace && pnpm test && pnpm build

# 9. Commit + push + open PR.
git commit -m "phase 3a-final: extract workspace SPA into apps/workspace/ [preview]"
git push -u origin phase-3a-final/extract-workspace-spa
gh pr create --base dev --title "..."
```

## Phase 4 final-cleanup playbook

Runs after Phase 2c-β + 3e merge. Sweeps every remaining `codex-*` reference.

### Prerequisites

- ✅ 2c-β merged (so `src/lib/sync/partyserver-provider.ts`, `src/lib/sync/y-partyserver-spike.test.ts` are deleted — they had the last `aquilla-sync-worker` refs in src/).
- ✅ 3e merged (so auth-worker is at apps/identity/; any `aquilla-identity` refs in its code/comments need updating to `aquilla-identity`).

### Steps

```bash
git fetch origin && git checkout -B phase-4-final-cleanup/codex-aquilla-residuals origin/dev

# 1. Sweep CLAUDE.md. Both 2c-β and 3e will have rewritten sections of it;
#    do a holistic re-read and update any remaining codex-* references.
$EDITOR CLAUDE.md  # manual edit

# 2. Sweep apps/identity (was auth-worker). 3e should have caught
#    most of these but verify with a grep:
grep -rn "aquilla-identity\|codex-web\|codex-db\b" apps/identity

# 3. Sweep packages for codex- references. Should be zero by now.
grep -rln "codex-" packages

# 4. Sweep e2e/, scripts/, .github/ for stragglers.
grep -rln "codex-" e2e scripts .github

# 5. Final sanity: across the whole repo (excluding node_modules and the
#    one historical mention in docs/superpowers/plans/*.md which can stay),
#    `codex-` should appear only in changelog / git-history-style contexts.
grep -rln "codex-" . | grep -v node_modules | grep -v dist | grep -v worktrees

# 6. Commit, push, PR.
git commit -m "phase 4 final-cleanup: residual codex-* refs [preview]"
```

## Phase 5 follow-up: wire StaleSourceIndicator into the cell editor

Runs after Phase 5 + Phase 2c-β + Phase 3a-final merge.

Phase 5 shipped `StaleSourceIndicator.tsx` as a standalone component (it doesn't render unless `cell.eventId != cell.sourceEventId` for the paired source). It's NOT yet rendered in the cell row, because at Phase 5 launch time the cell row was being rewritten by 2c-β.

After 3a-final lands, `apps/workspace/src/components/CellRow.tsx` (or wherever the per-cell status area ended up) gets a 5-line update:

```tsx
import { StaleSourceIndicator } from "@/components/StaleSourceIndicator"
// ...
<div className="cell-status">
  <ValidationStatus cell={cell} />
  <StaleSourceIndicator
    cellId={cell.cellId}
    projectId={projectId}
    fileId={fileId}
  />
</div>
```

## Cloudflare resource manual actions

The `aquilla.app` zone has not been provisioned. Several rollout steps depend on it. Sequence:

1. **Register `aquilla.app` with Cloudflare** (via dashboard, manual). Set up the DNS records.
2. **Create R2 buckets**: `aquilla-snapshots` and `aquilla-snapshots-staging`. Phase 4 partial (#83) updated wrangler.toml to reference these names; the buckets need to exist before sync-worker can deploy successfully (or revert the bucket-name lines in `apps/sync/wrangler.toml` if the rename is being delayed).
3. **Uncomment the `routes = [...]` claims** in every `apps/*/wrangler.toml`. Currently commented with a `# TODO: uncomment after aquilla.app zone is provisioned in Cloudflare` marker (one per env).
4. **Drop `continue-on-error: true`** from the deploy + smoke-test steps in `.github/workflows/deploy-all-apps.yml` once routes claim succeeds.
5. **Rename the Cloudflare Pages project** from `codex-web` to `aquilla-web` (manual dashboard action; CF doesn't support in-place Pages renames so this means creating a new project, updating CI to deploy there, and dropping the old project).

## Open questions / TODO

- `aquilla-web-4ih.pages.dev` is the current preview hostname pattern. After the Pages rename, what's the new pattern? The `[3]` referenced in commits (`aquilla-web-4ih.pages.dev`) is speculative — the actual subdomain CF assigns may differ.
- The husky pre-push hook's `e2e:smoke` step times out on agent sandbox environments (port :8787 wrangler-dev cold-start > 30s). Documented workaround: `SKIP_E2E_SMOKE=1 git push`. Real fix: either bump the spawn-worker timeout to 60s+ or run E2E only in CI (drop the pre-push hook).
- Email sending in preview environments: currently disabled per spec §"Preview identity". When the apps come online, verify that signup / password-reset flows surface tokens in the API response rather than email under `ENV=preview`.
