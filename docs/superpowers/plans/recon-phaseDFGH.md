# Recon: Phase D / F / G / H — Port-ready diff matrix

> Generated 2026-05-22. Read-only recon against `demo` HEAD `84867c8` vs `main` HEAD `1b2ac85`.
> Path-translation rule: `apps/identity/` → `auth-worker/`; `apps/sync/` → `sync-worker/`; `apps/workspace/src/` → `src/`.

---

## Phase D — Identity self-hosted (refs `87d3666`, `bb22bc1`, `57d54d3`)

### D.1 — `apps/identity/` file inventory (main)

| Category | Path on `main` (`apps/identity/`) | Responsibility |
|---|---|---|
| Entry point | `src/index.ts` | Mounts all routes under `/api/v2/`; 45+ route comments |
| Auth routes | `src/routes/auth.ts` | register, token, me, activity-log, password-reset |
| Sync-token | `src/routes/sync-token.ts` | POST `/api/v2/sync-token` |
| Projects | `src/routes/projects.ts` | CRUD projects, archive, files, members |
| Invites | `src/routes/invites.ts` | multi-project token, preview, accept |
| Orgs | `src/routes/orgs.ts` | org membership, org-scoped invites |
| Source linking | `src/routes/source-linking.ts` | link-source, detach-source, downstreams |
| Project settings | `src/routes/project-settings.ts` | GET/PUT project settings |
| Users | `src/routes/users.ts` | lookup + search |
| Test reset | `src/routes/test-reset.ts` | `/__test__/reset` (WRANGLER_LOCAL only) |
| Services | `src/services/org-permissions.ts` | org role resolution |
| | `src/services/project-permissions.ts` | project role tier resolution |
| | `src/services/source-linking.ts` | upstream/downstream chain logic |
| | `src/services/user-lookup.ts` | username → user row |
| | `src/services/email.ts` | Resend email wrapper |
| Auth lib | `src/auth/jwt.ts` | JWT sign/verify |
| Middleware | `src/middleware/auth.ts` | Bearer extraction |
| Types | `src/types.ts` | `Env`, `Variables` |
| Utils | `src/utils/password.ts` | bcrypt-compatible hash/verify |
| Migrations | `migrations/0001_initial.sql` … `migrations/0013_cells_pair_lookup.sql` | 14 sequential migrations; all own the single `aquilla-db` D1 |

### D.2 — File bucket: `apps/identity/src/` vs `auth-worker/src/` on demo

| `apps/identity/src/` file | Demo equivalent | Status |
|---|---|---|
| `index.ts` | `auth-worker/src/index.ts` | **DIFFERENT** — demo has only 3 routes (auth, sync-token, projects-invites). Main has 10+ routes. |
| `routes/auth.ts` | `auth-worker/src/routes/auth.ts` | Likely similar core; verify password-reset variants |
| `routes/sync-token.ts` | `auth-worker/src/routes/sync-token.ts` | ALREADY-IN-DEMO |
| `routes/projects-invites.ts` → split into `routes/invites.ts` + `routes/projects.ts` on main | `auth-worker/src/routes/projects-invites.ts` | **DIFFERENT** — demo file is a single combined routes file; main splits into projects + invites + orgs + source-linking + project-settings + users |
| `routes/orgs.ts` | ❌ not in demo | **MISSING-FROM-DEMO** |
| `routes/projects.ts` | ❌ not in demo (only `projects-invites.ts`) | **MISSING-FROM-DEMO** |
| `routes/source-linking.ts` | ❌ not in demo | **MISSING-FROM-DEMO** |
| `routes/project-settings.ts` | ❌ not in demo | **MISSING-FROM-DEMO** |
| `routes/users.ts` | ❌ not in demo | **MISSING-FROM-DEMO** |
| `routes/test-reset.ts` | ❌ not in demo | **MISSING-FROM-DEMO** |
| `services/org-permissions.ts` | ❌ not in demo | **MISSING-FROM-DEMO** |
| `services/project-permissions.ts` | ❌ not in demo | **MISSING-FROM-DEMO** |
| `services/source-linking.ts` | ❌ not in demo | **MISSING-FROM-DEMO** |
| `services/user-lookup.ts` | ❌ not in demo | **MISSING-FROM-DEMO** |
| `services/email.ts` | `auth-worker/src/services/email.ts` | ALREADY-IN-DEMO |
| `auth/jwt.ts` | `auth-worker/src/auth/jwt.ts` | ALREADY-IN-DEMO |
| `middleware/auth.ts` | `auth-worker/src/middleware/auth.ts` | ALREADY-IN-DEMO |
| `types.ts` | `auth-worker/src/types.ts` | **DIFFERENT** — main binds `AQUILLA_DB`; demo binds `AUTH_DB` (frontier-db-v2) |
| `utils/password.ts` | `auth-worker/src/utils/password.ts` | ALREADY-IN-DEMO |

**Test files** — demo has: `auth-routes`, `invites`, `jwt`, `password`, `sync-token`. Main adds: `multi-project-invites`, `project-permissions`, `project-settings`, `projects-create`, `source-linking` tests.

### D.3 — Migrations delta

| `apps/identity/migrations/` file | Demo `auth-worker/migrations/` | Note |
|---|---|---|
| `0001_initial.sql` → `0013_cells_pair_lookup.sql` | ❌ `auth-worker/` has **no `migrations/` directory** | All 14 migrations are **MISSING-FROM-DEMO**. Demo's `wrangler.toml` points at `frontier-db-v2`, not `aquilla-db`. The entire schema transfer (including `aquilla-db` D1 binding + `migrations_dir`) must be ported. |

### D.4 — `wrangler.toml` delta (key differences)

| Field | `apps/identity/wrangler.toml` (main) | `auth-worker/wrangler.toml` (demo) |
|---|---|---|
| `name` | `aquilla-identity` | `codex-auth-worker` |
| `routes` | `["aquilla.app/api/identity/*"]` | none |
| D1 binding | `AQUILLA_DB` → `aquilla-db` (id `11828e9d`) with `migrations_dir = "migrations"` | `AUTH_DB` → `frontier-db-v2` (id `9c6abd81`); no `migrations_dir` |
| `EMAIL_FROM` | `noreply@aquilla.app` | `noreply@frontierrnd.com` |

### D.5 — `frontier-server` URL / import references to cut (commit `57d54d3`)

**`src/` files on demo that still reference `frontier-server`, `frontierrnd`, or `frontier.`:**

| File | Reference | What the cut does (per `57d54d3`) |
|---|---|---|
| `src/lib/frontier/auth.ts` | `FRONTIER_BASE = "https://api.frontierrnd.com"` + `export const FRONTIER_BASE = AUTH_BASE` alias | Remove `FRONTIER_BASE` alias; rewrite to use `@aquilla/auth-client` + `AUTH_BASE` pointing at `aquilla-identity` |
| `src/lib/frontier/auth.test.ts` | `api.frontierrnd.com` URL expectations | Update test stubs to `AUTH_BASE` fallback |
| `src/lib/frontier/roles.ts` | `// frontier-server's ROLE_NAMES` comment reference | Comment-only; update to note identity worker |
| `src/lib/frontier/members.ts` | `// role came from in frontier-server's resolveProjectRole` | Comment-only |
| `src/lib/completion/frontier-health.ts` | `HEALTH_URL = "https://api.frontierrnd.com/api/v2/health"` | After `57d54d3`: repoint to `aquilla-chat-worker` health probe |
| `src/lib/completion/completion-service.ts` | `FRONTIER_CHAT_URL = ".../api/v1/chat/completions"` default to `api.frontierrnd.com` | Repoint to `aquilla-chat-worker` (no longer `frontierrnd.com`) |
| `sync-worker/src/auth.ts` | `// Pure JWT verification for sync-token claims issued by frontier-server's` | Comment-only; update |
| `sync-worker/src/admin.ts` | `// only frontier-server (which already holds...)` | Comment-only |
| `sync-worker/src/cors.ts` | `// or by frontier-server using SYNC_SECRET_KEY` | Comment-only |
| `sync-worker/src/index.ts` | `/** codex-db (frontier-server-owned schema)` + `/** Shared HMAC key with frontier-server` | Comment-only + env note |
| `sync-worker/src/events/role-policy.ts` | `// Numeric role levels matching frontier-server's role hierarchy.` | Comment-only |

> **Runtime cuts required** (non-comment): `src/lib/frontier/auth.ts` (remove `FRONTIER_BASE` export + switch to `@aquilla/auth-client`), `src/lib/completion/frontier-health.ts` (update `HEALTH_URL`), `src/lib/completion/completion-service.ts` (update `FRONTIER_CHAT_URL` default). All other occurrences are comments.

---

## Phase F — AD-13 branching search + corpus + KV cache (refs `c16ef51`, `a12eb2d`, `3e9fae2`, `f9a9f1b`)

### F.1 — Server-side: branching-search modules on main

| File on `main` (`apps/sync/src/`) | Responsibility | Demo path | Current state on demo |
|---|---|---|---|
| `lib/branching-search/algorithm.ts` | Pure BM25 + iterative coverage/branch loop. Deterministic. Types: `CorpusCell`, `BranchingSearchResult`. No D1/env. | `sync-worker/src/lib/branching-search/algorithm.ts` | ❌ **MISSING** |
| `lib/branching-search/corpus.ts` | D1 corpus loader. AD-9 `COALESCE` for linked-target projects. Returns `CorpusCell[]` pairs. | `sync-worker/src/lib/branching-search/corpus.ts` | ❌ **MISSING** |
| `lib/branching-search/settings.ts` | `BranchingSearchSettings` defaults + partial-merge helper + D1-backed loader from `project_settings.branchingSearch`. | `sync-worker/src/lib/branching-search/settings.ts` | ❌ **MISSING** |
| `lib/branching-search/cache.ts` | KV result cache keyed on `(project_id, query_hash, corpus_event_max)`. Binding: `BRANCHING_SEARCH_KV`. No-op when binding absent. | `sync-worker/src/lib/branching-search/cache.ts` | ❌ **MISSING** |
| `lib/branching-search/passages.ts` | Passage expansion: takes top-K results + walks ±radius along anchor chain. Returns `Passage[]`. | `sync-worker/src/lib/branching-search/passages.ts` | ❌ **MISSING** |
| `events/branching-search-route.ts` | `GET /api/v1/projects/:id/branching-search` — loads corpus, runs algorithm, uses cache. | `sync-worker/src/events/branching-search-route.ts` | ❌ **MISSING** |
| `events/branching-search-passages-route.ts` | `GET /api/v1/projects/:id/branching-search/passages` — for batch AI copilot path. | `sync-worker/src/events/branching-search-passages-route.ts` | ❌ **MISSING** |

Both routes must be registered in `sync-worker/src/index.ts` (mirror `apps/sync/src/index.ts` additions from `c16ef51` + `3e9fae2`).

### F.2 — Client-side: AI copilot rewire on main → demo paths

| File on `main` (`apps/workspace/src/`) | Demo path | Change summary | Current state on demo |
|---|---|---|---|
| `lib/sync/branching-search-read-types.ts` | `src/lib/sync/branching-search-read-types.ts` | `BranchingSearchResponse` type: `{ results: BranchingSearchResult[], provenance: ... }` | ❌ **MISSING** |
| `lib/sync/branching-search-read.ts` | `src/lib/sync/branching-search-read.ts` | Typed fetcher for `GET /branching-search`. Class `BranchingSearchError`. | ❌ **MISSING** |
| `lib/sync/branching-search-passages-read-types.ts` | `src/lib/sync/branching-search-passages-read-types.ts` | `Passage` + `BranchingSearchPassagesResponse` types | ❌ **MISSING** |
| `lib/sync/branching-search-passages-read.ts` | `src/lib/sync/branching-search-passages-read.ts` | Typed fetcher for `GET /branching-search/passages` | ❌ **MISSING** |
| `hooks/useCompletion.ts` | `src/hooks/useCompletion.ts` | Accepts `searchFn: SearchFn` + `searchPassagesFn: SearchPassagesFn` callbacks; no direct index call. Demo still imports `ScoredPair` from `@/lib/search/dual-index` but wires the old `useSearchIndex` path. | **DIFFERENT** — demo uses local `dual-index`; main routes through server callbacks |
| `components/ProjectWorkspace.tsx` | `src/components/ProjectWorkspace.tsx` | Imports `fetchBranchingSearch` + `fetchBranchingSearchPassages`; creates `branchingSearch`/`branchingSearchPassages` callbacks; passes into `useCompletion`. | **DIFFERENT** — demo has no branching-search wiring |

### F.3 — `branchingSearch` tunables from `project_settings` (commit `a12eb2d`)

- Main adds `branchingSearch` sub-object to `project_settings` JSON blob (`settings.ts` extended defaults + partial-merge).
- `apps/sync/src/events/branching-search-route.ts` loads settings via `loadBranchingSearchSettings(db, projectId)`.
- Demo path: `sync-worker/src/lib/branching-search/settings.ts` — **MISSING**.

### F.4 — `/passages` route + KV cache (commit `3e9fae2`)

- New route `GET /api/v1/projects/:id/branching-search/passages` added to `apps/sync/src/index.ts`.
- `BRANCHING_SEARCH_KV` KV namespace binding added to `apps/sync/wrangler.toml`.
- Demo: neither the route nor the KV binding exists in `sync-worker/src/index.ts` or `sync-worker/wrangler.toml`.

### F.5 — `idx_cells_pair_lookup` migration (commit `f9a9f1b`)

- **Exact SQL path on main:** `apps/identity/migrations/0013_cells_pair_lookup.sql`
- **SQL:** `CREATE INDEX idx_cells_pair_lookup ON cells(project_id, cell_id, side);`
- **Demo path:** `auth-worker/migrations/0013_cells_pair_lookup.sql` — but demo has **no migrations directory at all**. This migration must be included when the full migrations dir is created (Phase D prerequisite).
- Note: main applies this via `deploy-apps-prod.yml` which runs `wrangler d1 migrations apply aquilla-db --remote`. Demo will need the same workflow or manual apply.

---

## Phase G — AD-14 decay health (refs `f01b779`, `24323c4`, `553ec95`)

### G.1 — Files to DELETE on demo (four-sub-score health, commit `24323c4`)

These files exist on demo and are **deleted** in `24323c4`:

| Demo path | Deleted in | Notes |
|---|---|---|
| `src/lib/health/health-engine.ts` | `24323c4` | Old four-sub-score engine |
| `src/lib/health/health-engine.test.ts` | `24323c4` | |
| `src/lib/health/config-resolver.ts` | `24323c4` | |
| `src/lib/health/config-resolver.test.ts` | `24323c4` | |
| `src/lib/health/defaults.ts` | `24323c4` | |
| `src/lib/health/defaults.test.ts` | `24323c4` | |
| `src/lib/health/composite/compute.ts` | `24323c4` | |
| `src/lib/health/composite/compute.test.ts` | `24323c4` | |
| `src/lib/health/composite/ancestry-penalty.ts` | `24323c4` | |
| `src/lib/health/composite/ancestry-penalty.test.ts` | `24323c4` | |
| `src/lib/health/composite/neighborhood-penalty.ts` | `24323c4` | |
| `src/lib/health/composite/neighborhood-penalty.test.ts` | `24323c4` | |
| `src/lib/health/composite/rule-penalty.ts` | `24323c4` | |
| `src/lib/health/composite/rule-penalty.test.ts` | `24323c4` | |
| `src/lib/health/composite/validation-gap.ts` | `24323c4` | |
| `src/lib/health/composite/validation-gap.test.ts` | `24323c4` | |
| `src/hooks/useCompositeHealth.ts` | `24323c4` | |
| `src/hooks/useCompositeHealth.test.tsx` | `24323c4` | |
| `src/workers/health-worker.ts` | `24323c4` | |
| `src/workers/health-worker-sync.ts` | `24323c4` | |
| `src/workers/health-worker-sync.test.ts` | `24323c4` | |
| `src/components/HealthBreakdown/BreakdownContent.tsx` | `24323c4` | |
| `src/components/HealthBreakdown/BreakdownPopover.tsx` | `24323c4` | |
| `src/components/HealthBreakdown/BreakdownTooltip.tsx` | `24323c4` | |
| `src/components/HealthBreakdown/HealthBreakdown.test.tsx` | `24323c4` | |
| `src/components/HealthBreakdown/HealthBreakdown.tsx` | `24323c4` | |
| `src/components/HealthBreakdown/bands.ts` | `24323c4` | |
| `src/components/HealthBreakdown/bands.test.ts` | `24323c4` | |
| `src/components/ProjectSettings/HealthSettingsSection.tsx` | `24323c4` | Replaced by `DecaySettingsSection.tsx` |
| `src/components/ProjectSettings/HealthSettingsSection.test.tsx` | `24323c4` | |

### G.2 — Files to PORT from main (decay engine + biggest-drags popover)

| File on `main` | Demo path | Status on demo |
|---|---|---|
| `apps/workspace/src/lib/health/decay-engine.ts` | `src/lib/health/decay-engine.ts` | ❌ **MISSING** |
| `apps/workspace/src/lib/health/decay-engine.test.ts` | `src/lib/health/decay-engine.test.ts` | ❌ **MISSING** |
| `apps/workspace/src/components/DecayBreakdown.tsx` | `src/components/DecayBreakdown.tsx` | ❌ **MISSING** |
| `apps/workspace/src/components/ProjectSettings/DecaySettingsSection.tsx` | `src/components/ProjectSettings/DecaySettingsSection.tsx` | ❌ **MISSING** |

**`decay-engine.ts` key exports:** `computeDecayHealth`, `DECAY_DEFAULTS` (`endorsementTarget: 5`, `decayWarnThreshold: 0.66`), `HealthStats` interface (replaces the old interface from `health-engine.ts`).

**`DecayBreakdown.tsx`** — AD-14 "biggest drags" popover. Props: `health`, `scopeLabel`, `healthByCell: Array<{cellId, label, health}>`, `warnThreshold`, `staleSourceCount`, `onJumpToCell`.

**Other modified files** (need targeted edits, not wholesale replacement):

| Main file | Demo path | Change summary |
|---|---|---|
| `apps/workspace/src/hooks/useHealth.ts` | `src/hooks/useHealth.ts` | Switch from `computeHealthMap` (old engine) to `computeDecayHealth`. Remove `useCompositeHealth` dependency. Add per-cell infraction cache (see G.3). |
| `apps/workspace/src/components/EditorTable.tsx` | `src/components/EditorTable.tsx` | Remove `HealthBreakdown` imports; wire `DecayBreakdown` |
| `apps/workspace/src/components/ProjectSettings.tsx` | `src/components/ProjectSettings.tsx` | Replace `HealthSettingsSection` with `DecaySettingsSection` |
| `apps/workspace/src/components/StatusBar.tsx` | `src/components/StatusBar.tsx` | Simplify health display to single decay number |
| `apps/workspace/src/hooks/useProjectSettings.ts` | `src/hooks/useProjectSettings.ts` | Expose `decaySettings` field (from `f01b779`) |
| `apps/workspace/src/lib/parsers/types.ts` | `src/lib/parsers/types.ts` | `DecaySettings` type added; many four-sub-score types removed (`RulePenalties`, `HealthConfig`, `CellHealthBreakdown` stripped) |

### G.3 — `useHealth` memoisation (commit `553ec95`)

**What changed:** Per-cell infraction cache keyed on `(status, original, translated)` content signature. Invalidates the full cache when the enabled-rule set changes.

**The pattern to port** (to `src/hooks/useHealth.ts`):

```ts
const infractionsCacheRef = useRef<{
  rulesSig: string
  byCell: Map<string, { sig: string; infractions: RuleInfraction[] }>
}>({ rulesSig: "", byCell: new Map() })

// Inside the infractions useMemo:
const rulesSig = JSON.stringify(enabledRules.map((r) => [r.id, r.name, r.check]))
const rulesChanged = cache.rulesSig !== rulesSig

for (const [fileId, cells] of fileCells) {
  for (const cell of cells) {
    const sig = `${cell.status} ${cell.original} ${cell.translated}`
    const prev = rulesChanged ? undefined : cache.byCell.get(cell.id)
    const entry = prev && prev.sig === sig
      ? prev
      : { sig, infractions: checkRulesForCell(cell, fileId, enabledRules) }
    nextByCell.set(cell.id, entry)
    // ...
  }
}
infractionsCacheRef.current = { rulesSig, byCell: nextByCell }
```

**Current state on demo:** `src/hooks/useHealth.ts` uses the old `computeHealthMap` from `health-engine.ts` (not `computeDecayHealth`). It has no per-cell infraction cache — `checkRulesForCell` is not imported. The file re-runs full health computation on every keystroke.

> `553ec95` commit note: "Every commit revalidates the cells array and rebuilds fileCells to a new Map ref, so the useMemo re-evaluates every rule against every cell on every keystroke-blur — ~8s+ on a Bible book."

---

## Phase H — Server-side import projection (refs `b6155ae`, `4bb0aec`, `c1b35b6`)

### H.1 — `POST /import` route on main's sync

- **Exact path on main:** `apps/sync/src/events/import-route.ts`
- **Demo path:** `sync-worker/src/events/import-route.ts` — ❌ **MISSING**
- **Current demo state:** `sync-worker/src/events/route.ts` exists (generic POST /events); no bulk import fast path.

**Route responsibilities (`b6155ae`):**
- Auth: verifies `aud=sync` token scoped to `(projectId, fileId)`, role `>= PROJECT_LEAD` (role-policy).
- Accepts: `{ file: ImportFileMeta, cells: ImportCell[] }` JSON body (streamed in chunks from client).
- Skips the per-event D1 read guards (idempotency + parent-chain) that `POST /events` does.
- Reuses `buildEventProjectionStmts` from `event-projection.ts` verbatim (same rows, byte-identical).
- Batches D1 writes in groups of 100 statements max (`D1_BATCH_LIMIT = 100`).
- One `MAX(server_seq)` read per request; everything else is writes.
- The route must be registered in `sync-worker/src/index.ts`.

### H.2 — Client-side bulk-enqueue change (eBible importer, commit `4bb0aec`)

| File on `main` | Demo path | Status |
|---|---|---|
| `apps/workspace/src/lib/sync/bulk-import.ts` | `src/lib/sync/bulk-import.ts` | ❌ **MISSING** |
| `apps/workspace/src/lib/sync/bulk-import.test.ts` | `src/lib/sync/bulk-import.test.ts` | ❌ **MISSING** |

**`bulk-import.ts` responsibilities:**
- Exports `bulkUploadSource({ syncWorkerOrigin, syncToken, projectId, fileId, file, cells, onProgress })`.
- Streams cells to `POST /import` in chunks of `CHUNK = 1500` cells per request.
- Each chunk: `1500 cells × 2 D1 stmts = 3000 stmts ÷ 100 batch-limit = 30 D1 batches per request`.
- Idempotent (`INSERT OR IGNORE`); failed chunk can be retried by re-running.

**`apps/workspace/src/lib/import.ts` changes** (`b6155ae`):
- Demo's `src/lib/import.ts` still uses `createFileDoc` + Y.Doc writebacks (the old path).
- Main's `import.ts` (post-`b6155ae`) imports `bulkUploadSource` from `./sync/bulk-import` and calls it for eBible import — no Y.Doc, no outbox drip.
- Demo path `src/lib/import.ts` — **DIFFERENT** (still Y.Doc path; must be rewritten to bulk-upload path).

**`apps/workspace/src/lib/sync/events-emit.ts` changes** (`4bb0aec`):
- Adds single-IDB-transaction bulk-enqueue helper so all events for a file.create + N cell.creates land in one IDB transaction.
- Demo path `src/lib/sync/events-emit.ts` — **DIFFERENT** (verify if bulk-enqueue exists).

### H.3 — Onboarding creates server project row (commit `c1b35b6`)

| File on `main` | Demo path | Change |
|---|---|---|
| `apps/workspace/src/components/onboarding/steps/ProjectStep.tsx` | `src/components/onboarding/steps/ProjectStep.tsx` | If signed in, call `createRemoteProject` (from `@aquilla/api-client`) **before** the local `createLocalProject` (IDB). Mirror `ProjectCreateDialog`'s pattern. |
| `apps/workspace/src/lib/store/project-index.ts` | `src/lib/store/project-index.ts` | `tombstoneProject` handles orphan IDB rows when server returns 403 ("no row for id") — reclassifies as `local-only` and continues with local tombstone. |

**Current demo state:**
- `src/components/onboarding/steps/ProjectStep.tsx` only calls `createProject` (local IDB, line 40); no `createRemoteProject` call.
- `src/lib/store/project-index.ts` exists; verify whether the `local-only` 403 reclassification is already present (the comment at line 175 says it is — partially ported from main).

---

## Summary table — work items per phase

| Phase | New files (port) | Modified files | Deleted files | Prerequisite |
|---|---|---|---|---|
| **D** | `auth-worker/migrations/0001–0013` (14), `src/routes/orgs, projects, source-linking, project-settings, users, test-reset`, `src/services/org-permissions, project-permissions, source-linking, user-lookup` | `auth-worker/src/index.ts`, `auth-worker/src/types.ts`, `auth-worker/wrangler.toml`, `src/lib/frontier/auth.ts`, `src/lib/completion/frontier-health.ts`, `src/lib/completion/completion-service.ts` | None | Phase C (rename pass — `AUTH_DB → AQUILLA_DB`) |
| **F** | `sync-worker/src/lib/branching-search/` (5 files), `sync-worker/src/events/branching-search-route.ts`, `sync-worker/src/events/branching-search-passages-route.ts`, `src/lib/sync/branching-search-read.ts`, `src/lib/sync/branching-search-read-types.ts`, `src/lib/sync/branching-search-passages-read.ts`, `src/lib/sync/branching-search-passages-read-types.ts` | `sync-worker/src/index.ts` (register 2 routes), `sync-worker/wrangler.toml` (add KV binding), `src/hooks/useCompletion.ts`, `src/components/ProjectWorkspace.tsx` | None | Phase D (AQUILLA_DB binding); Phase F.5 migration is part of Phase D migration set |
| **G** | `src/lib/health/decay-engine.ts`, `src/lib/health/decay-engine.test.ts`, `src/components/DecayBreakdown.tsx`, `src/components/ProjectSettings/DecaySettingsSection.tsx` | `src/hooks/useHealth.ts` (full rewrite), `src/components/EditorTable.tsx`, `src/components/ProjectSettings.tsx`, `src/components/StatusBar.tsx`, `src/hooks/useProjectSettings.ts`, `src/lib/parsers/types.ts` | 30 files (listed in G.1) | None (self-contained) |
| **H** | `sync-worker/src/events/import-route.ts`, `src/lib/sync/bulk-import.ts`, `src/lib/sync/bulk-import.test.ts` | `sync-worker/src/index.ts` (register route), `src/lib/import.ts` (switch to bulk-upload), `src/lib/sync/events-emit.ts` (bulk-enqueue IDB tx), `src/components/onboarding/steps/ProjectStep.tsx` (server row first), `src/lib/store/project-index.ts` (orphan 403 handling) | None | Phase A (events foundation — `buildEventProjectionStmts` must exist in `sync-worker/src/events/event-projection.ts`) |
