# AGENT-API swarm — orchestration state (AQU-533)

Started: 2026-07-13 · Orchestrator: Claude (Fable) session w/ Ryder
Spec: `docs/AGENT-API.md` (draft v2, post-review — the authoritative design)
Integration branch: `swarm/integration` @ worktree `.worktrees/swarm-integration`
Base: dev @ 9dace448b

## STOP criteria (acceptance)

Maps to AGENT-API.md §6 release gates. This swarm targets gates 1–4, 6, 7, 8, 9
end-to-end, plus gate 5 (USFM import) and a gate-10 cold-start smoke if waves stay
green. STOP when:

- [ ] G1: External credentials: mint/list/revoke via auth-worker routes; hashed at rest;
      org/project scoping; ask|act ceiling; expiry + last_used + revocation enforced
- [ ] G2: Read surface: search / read_content / read_history callable with a credential
      (bearer), permission-checked live
- [ ] G3: SetTranslation commands → changeset → compiled canonical events (AD-9 pinning
      preserved: sourceEventId + parent chain)
- [ ] G4: Artifact upload via signed URL → R2, preserved + linkable to file
- [ ] G5: One end-to-end import: USFM via PlanImport + recipe → staged changeset → job
- [ ] G6: Ask/act enforced: ask credential CANNOT commit; one-time approval assertion
      (authed browser page) consumed exactly once; plan_stale on precondition violation
- [ ] G7: Permission-parity tests: API caller can do exactly what the same user can
      in-app, nothing more (role matrix test per command)
- [ ] G8: Server-stamped provenance envelope on all event-backed mutations; execution
      receipts on commits/jobs
- [ ] G9: Docs: minimal REST + MCP docs, one worked example
- [ ] MCP adapter: remote MCP exposing the §4 tool surface against the command layer
- [ ] Mechanical gate green on integration: root `tsc -b --noEmit` + `vitest run` +
      `pnpm build`, and per-worker `npm test` in auth-worker + sync-worker
- [ ] Adversarial review panel passed (races / regressions / contract+permission lenses)

Storage decision (SCOUT-CORRECTED): sync-worker ALREADY runs on shared Postgres
(Neon via Hyperdrive; `db/postgres/migrations/`, latest 0053; avoid the existing
0050 numbering collision — use 0054+). Changesets/credentials/jobs = shared Postgres
migrations. R2 for artifacts via worker-proxied PUT (repo has NO presigned-URL
pattern; do not invent one). CLAUDE.md's "workers still run on D1" is stale.

## Operating model

- Workflow-mode fan-out (user present): `Workflow` tool per wave, `isolation:
  'worktree'`, schema-validated returns. Orchestrator merges each agent's branch into
  `swarm/integration` (3-way merges accepted), runs the mechanical gate, reverts red
  merges and respawns fixers.
- Agents NEVER push, NEVER touch `main`/`dev`, NEVER merge. Deliverable = commits on
  their own worktree branch + structured report.
- Model mix: opus for design-heavy cores (credentials/auth middleware, command+changeset
  engine, MCP adapter); sonnet for well-scoped surfaces (reads, artifacts, approval
  page, docs, parity tests).
- Every agent appends open TODOs to `docs/swarm/AGENT-API-TRACES.md` (create if absent)
  and lists them in its return payload.

## Waves

### Wave 1 — foundation (3 agents, parallel, disjoint ownership)
- **W1-A credentials + auth (opus)** — auth-worker: D1 migration (`api_credentials`),
  mint/list/revoke routes, bearer resolution → user + LIVE role check, shared
  validation module usable by sync-worker (same D1 `aquilla-db`). Owns:
  `auth-worker/migrations/00XX_api_credentials.sql`, `auth-worker/src/routes/credentials*`,
  `auth-worker/src/lib/credentials/*`, tests. Forbidden: sync-worker/, src/ (except none).
- **W1-B command/changeset engine (opus)** — sync-worker: migrations (`changesets`,
  `changeset_commands`), command types + validation (SetTranslation first), compile→
  canonical events, server-computed effect summary, preconditions + plan_stale,
  confirm/discard, provenance envelope stamping, execution receipts. Owns:
  `sync-worker/migrations/*`, `sync-worker/src/external/*` (new dir), touches
  event-projection only additively. Forbidden: auth-worker/, src/, project-do.ts.
- **W1-C read surface + error contract (sonnet)** — sync-worker: external read routes
  (search/read_content/read_history) behind a credential-auth seam (interface defined
  in brief; W1-B/A land the real validator), stable error codes module
  (`permission_denied`, `scope_denied`, `plan_stale`, `confirmation_required`,
  `validation_failed`, `job_failed`, `rate_limited`), cursor pagination helper. Owns:
  `sync-worker/src/external/read-*`, `sync-worker/src/external/errors.ts`, tests.

### Wave 2 — adapters + flows (after W1 merged green)
- **W2-A MCP adapter (opus)** — remote MCP server exposing §4 tools against the command
  layer; get_capabilities / get_identity_and_scope discovery.
- **W2-B artifacts + import (opus or sonnet by scout findings)** — R2 signed-URL upload,
  inspect_artifact, USFM recipe → PlanImport → job. May require extracting the USFM
  parser into a shared package.
- **W2-C approval flow (sonnet)** — auth-worker approval-assertion endpoints (one-time,
  bound: user × changeset digest × credential × expiry) + SPA `/approve/:changesetId`
  page (server-computed summary, approve/reject). Ask-credential commit DENIED without it.
- **W2-D REST adapter + OpenAPI stub (sonnet)** — REST resources over the same commands.

### Wave 3 — proof
- **W3-A permission-parity + ask/act matrix tests (sonnet)**
- **W3-B docs + worked example (sonnet)** — docs/api/*, Blackfoot-style USFM example.
- **W3-C cold-start smoke** — scripted agent-shaped walk: capabilities → create →
  import → translate → check → export.
- Adversarial review panel → fix/revert → orchestrator final gate → (with Ryder) dev push.

## Cross-agent interface contracts (Wave 1 — agents code against these exactly)

- `db/shared/api-credentials.ts` (OWNED by W1-A):
  `validateApiCredential(db: AquillaDb, token: string): Promise<ApiCredentialContext | null>`
  where `ApiCredentialContext = { credentialId: string; userId: string; username: string;
  mode: "ask" | "act"; orgId: string | null; projectId: string | null }`.
  Token format: `aqk_<base64url>`; SHA-256 hash at rest; expiry/revocation checked here.
- `db/shared/project-roles.ts` (OWNED by W1-A): port of auth-worker
  `resolveProjectRole` max-wins logic as
  `resolveProjectRoleShared(db, user: {id, email?}, projectId): Promise<{level, source} | null>`.
  Do NOT refactor auth-worker to use it in W1 (blast radius) — note dup in TRACES.
- `sync-worker/src/external/token-bridge.ts` (OWNED by W1-B):
  `mintInternalSyncToken(env, db, cred: ApiCredentialContext, projectId, fileId?): Promise<string>`
  — resolves role via project-roles + scope-checks the credential (org/project match),
  signs a short-lived internal sync JWT with SYNC_SECRET_KEY, so ALL external writes
  and reads flow through the existing authorize.ts perimeter unchanged.
- `sync-worker/src/external/errors.ts` (OWNED by W1-B): `errorResponse(code, message,
  details?)`; codes: permission_denied | scope_denied | plan_stale |
  confirmation_required | validation_failed | job_failed | rate_limited | not_found.
  W1-C may ship a local fallback shim marked `SWARM-TODO: unify` if merging first.
- Migration numbers RESERVED: 0054 = api_credentials (W1-A); 0055 = changesets +
  changeset_confirmations + events.provenance column (W1-B). Nobody else adds
  migrations in Wave 1.

## Merge log
| when | branch | result | notes |
| --- | --- | --- | --- |
| 2026-07-13 | (setup) | ff dev→integration @ 9dace448b | reused prior swarm worktree, 0 unique commits |
| 2026-07-13 | dev @ ccd631e17 | merged | dev advanced mid-swarm (remote merge); integration synced |
| 2026-07-13 | swarm/agent-api-w1b-changesets | merged 49d855bae | engine + 0055 migration + provenance; 9 tests |
| 2026-07-13 | swarm/agent-api-w1c-reads | merged 93b692742 | add/add conflicts resolved: errors.ts unioned (externalError alias), stubs split (api-credentials-db.ts); 14 tests |
| 2026-07-13 | GATE | GREEN | sync-worker tsc clean; 76 files / 788 tests pass |
| 2026-07-13 | swarm/agent-api-w1a-credentials | merged 549804917 | schema.sql union conflict resolved; 11 tests; pre-existing invites.test.ts failure noted |
| 2026-07-13 | swarm/agent-api-w1d-reconcile | merged 6bfa5b206 | stubs deleted, real db/shared wired; 788/788 green; userId string→number conversion at token-bridge boundary |
| 2026-07-13 | WAVE 2 DISPATCHED | — | w2a-mcp (opus), w2b-import (opus), w2c-approval (sonnet) in .worktrees/w2{a,b,c}-* off 6bfa5b206 |
| 2026-07-13 | swarm/agent-api-w2c-approval | merged fd5ab8519 | approval endpoints + /approve page; 12+3 tests |
| 2026-07-13 | swarm/agent-api-w2a-mcp | merged 7c4583edf | 11-tool MCP server; TRACES union-resolved; 18 tests |
| 2026-07-13 | swarm/agent-api-w2b-import | merged afdc3fec8 | artifacts (0056) + PlanImport; index.ts union (both handlers kept); 12 tests |
| 2026-07-13 | GATE (Wave 2) | GREEN | sync-worker tsc + 818/818; auth-worker tsc + 650/651 (1 PRE-EXISTING invites.test.ts failure, task chip spawned); root tsc -b clean; ApproveChangeset 3/3 |
| 2026-07-13 | WAVE 3 DISPATCHED | — | w3a-parity (sonnet), w3b-docs (sonnet), w3c-coldstart (opus) off afdc3fec8 |

Post-merge fixups owed (from wave-2 reports, for reviewer panel to check):
- mcp-tools get_capabilities: commandKinds/limits may be hardcoded pre-PlanImport-merge
  → verify it now reports PlanImport + PLAN_IMPORT_MAX_CELLS after the W2-B merge.
- PlanImport partial-apply: changeset marked committed with job_failed receipt; no
  rollback path (traced; acceptable v1 if receipt honest).

INCIDENT LOG: first W1-B/W1-C merge accidentally ran in the MAIN worktree on dev
(orchestrator cwd reset between tool calls). Recovered: merge --abort + hard reset
dev→ccd631e17 (only the accidental merge commit removed; user's untracked files
untouched). Lesson: EVERY git command in this swarm must be prefixed with an
explicit `cd` to the intended worktree — never rely on persistent cwd.

W1-A NOTE: first run died on a provider server error; rerun in flight. W1-B's stub
assumed userId:number + autonomyMode field + resolveProjectRoleShared(db, projectId,
userId); the contract says userId:string-or-actual-users.id-type, mode field,
(db, user, projectId). Reconciliation pass (W1-D) must unify stubs → db/shared.

## Known landmines (from repo docs + memory)
- Root vitest EXCLUDES sync-worker/**; worker tests run per-package with npm.
- React Compiler drops version-only memo deps — use readAtVersion() in stores (SPA only).
- Safari drops *.workers.dev — external API must mount under aquilla.app/api/* routes;
  keep `routes` out of CI-deployed wrangler.toml top level.
- Untracked file in MAIN tree only: auth-worker/migrations/0035_docx_r2_roundtrip.sql —
  integration branch does NOT have it; new auth-worker migrations must use 0036+ to
  avoid colliding when it lands.
- D1 single-writer: no per-row aggregate recompute loops in projection; large manifests
  belong in R2, referenced by digest.
