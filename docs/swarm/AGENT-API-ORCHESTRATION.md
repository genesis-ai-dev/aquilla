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

Storage decision (D9 fallback exercised): changesets/credentials/jobs on **D1** via
migrations, schema written to port cleanly to Postgres. R2 for artifacts. Do NOT wire
Neon in this swarm.

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

## Merge log
| when | branch | result | notes |
| --- | --- | --- | --- |
| 2026-07-13 | (setup) | ff dev→integration @ 9dace448b | reused prior swarm worktree, 0 unique commits |

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
