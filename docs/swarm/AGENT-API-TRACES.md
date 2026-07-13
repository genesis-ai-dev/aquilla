# AGENT-API swarm — open traces / TODOs

Agents: append TODOs you could not finish, with file:line and enough context for a
fresh agent to pick up. Orchestrator: drain into wave briefs or sub-issues.

## Open

- W2-C (approval page, this wave): `ChangesetSummary` (sync-worker/src/external/types.ts)
  currently only carries `translationsAdded`, `translationsModified`, `warnings` — no
  `filesCreated` field yet, even though docs/AGENT-API.md §3 sketches "creates 1 file
  (Genesis.usfm)…" as part of the effect summary. `ApproveChangeset.tsx`
  (src/pages/ApproveChangeset/ApproveChangeset.tsx) already iterates summary keys
  generically (skips `warnings`, renders any other number/string key), so it'll pick up
  `filesCreated` for free once `PlanImport`/`prepare.ts` starts populating it — no
  follow-up needed there, just noting the summary shape is still import-command-shaped
  (translations only) as of this wave.
- W2-C: the approval page's error-message extraction (`parseErrorMessage` in
  ApproveChangeset.tsx) reads `error.message` off the sync-worker/auth-worker envelope
  but doesn't special-case `error.details.code === 'digest_mismatch'` with a friendlier
  copy — it just shows the server's message string ("digest mismatch — the plan you're
  approving doesn't match the staged changeset"), which is already human-readable, so this
  is a nice-to-have, not a bug.
- W2-C: auth-worker/src/routes/changeset-approvals.ts's authZ is intentionally v1-narrow
  (session user id === changesets.created_by_user_id, per the task spec — "only the
  credential's owning human approves their agent's work"). If a future wave wants
  org/project maintainers to be able to approve on behalf of another member's credential,
  that's a deliberate scope change, not an oversight here.
### W2-A (MCP adapter) — follow-ups

- **MCP tool coverage lags REST.** `sync-worker/src/external/mcp-tools.ts` ships 11
  tools (discovery, reads, translations, changesets). The doc's §4 surface also lists
  `create_project`/`update_project`, artifacts (`create_artifact_upload`,
  `inspect_artifact`), ingestion (`preview_import`, `prepare_import`), verification
  (`run_checks`), jobs (`get_job`), and export (`prepare_export`, `get_export`). These
  are unimplemented at the command layer (no `PlanImport`/`LinkMedia` in `commands.ts`
  yet) — add MCP tools as those commands land. `get_capabilities.commandKinds` and the
  tools/list catalog must be kept in sync when they do.
- **`maxCommandsPerChangeset` is `null`** in `get_capabilities` because Wave-1
  `commands.ts::validateCommands` enforces no per-changeset cap. If/when a cap is added
  (§8 open Q3 rate-limit/job-size numbers), publish the real value from
  `mcp-handlers.ts::getCapabilities`.
- **No OAuth 2.1 / connector-directory transport.** Auth is `aqk_` PAT bearer only
  (D12 defers OAuth). The MCP endpoint is stateless with no session id; a streamable-HTTP
  SSE stream (GET) is intentionally 405 (tools-only, no server-initiated messages). Add
  OAuth + optional SSE when connector-directory listing is pursued.
- **`list_projects` omits group-grant access.** Per the W2-A brief it unions
  project_members / created_by / org_members only; `resolveProjectRoleShared` also honors
  `group_project_grants`. A user whose ONLY access path is a group grant will not see the
  project in `list_projects` (though `get_project` on it still resolves). Widen the union
  if group-only access needs discovery. See `mcp-handlers.ts::listProjects`.

### W2-B (artifacts + PlanImport) — Wave-3 deferrals

- **Server-side recipe parsing (Wave-3 TRACE).** PlanImport receives cells
  ALREADY PARSED (client/agent-side), exactly like the SPA `/import` path. The
  server does not parse USFM/JSON/XLIFF into cells. `sync-worker/src/external/artifacts-route.ts`
  `/inspect` only does lightweight format DETECTION (marker sniff over the first
  64KB), not extraction. A future wave should add a `preview_import` /
  recipe-driven parse that turns an artifact into a cell manifest server-side
  (AGENT-API §5). Until then the agent must parse and pass `cells[]`.
- **Manifest-in-R2 for large imports (Wave-3 TRACE).** `PlanImport` caps cells at
  `PLAN_IMPORT_MAX_CELLS = 5000` (`sync-worker/src/external/commands.ts`),
  returning `validation_failed` above it. AGENT-API §3/§5 calls for large plans
  to reference an immutable manifest in R2 by digest rather than inlining
  thousands of operations in the changeset JSON. Biblica-scale (AQU-550) imports
  need this; today they must be split into ≤5000-cell PlanImport changesets.
- **Presigned artifact upload/download (design §4 D10).** Artifact bytes are
  worker-proxied (`POST/GET .../artifacts[/:id/content]` stream through the
  Worker) because this repo has NO presigned-URL pattern. The design targets
  signed HTTP upload/download URLs for binary transfer. A later wave should add
  the signed-URL flow (mirrors the `/audio` proxy → signed-URL migration if/when
  that lands) and publish max sizes in `get_capabilities`.
- **Partial-apply semantics of PlanImport commit.** `commitPlanImport`
  (`sync-worker/src/external/commit.ts`) chunks events to the `/events` perimeter
  at 100/POST. If any chunk has rejects while others land, the changeset is
  marked `committed` (event ids regenerate per attempt, so a retry would create a
  DUPLICATE file — committing makes re-commit idempotent) but the response is
  `job_failed` with the partial receipt. Revisit if a compensating/rollback path
  for half-imported files is wanted (delete the file.create'd file on partial
  failure).
- **Artifact GC.** A failed `artifacts` INSERT rolls back its R2 object, but
  artifacts whose PlanImport changeset is never committed (or is discarded) keep
  their R2 bytes + row indefinitely (`file_id` stays NULL). No TTL/GC job exists.

### W3-B (docs) — surprises found while writing the practitioner guide

- **`channel` in the provenance envelope is hardcoded `"rest"` regardless of adapter.**
  `sync-worker/src/external/commit.ts` (`buildProvenance` and the inline `provenance` object in
  `handleCommit`) always sets `channel: 'rest'`, even when the commit was reached via
  `confirm_changeset` over MCP (`mcp-handlers.ts::confirmChangeset` delegates to the same REST
  commit handler through a synthetic in-process `Request`). The design doc's §2 envelope sketch
  implies `channel` should distinguish `"mcp"` vs `"rest"`. Not a bug exactly — MCP genuinely
  goes through the REST handler internally — but it means the envelope cannot answer "did this
  come in over MCP or REST" today, which the design doc's provenance promise implies it should.
  Documented as a spec-vs-implementation gap in `docs/api/agent-api.md` §6.
- **No audit ledger exists.** The design doc's D7/§2 calls for a bounded-retention audit ledger
  for reads/searches/check-runs/discarded plans, separate from the event log. `db/postgres/
  schema.sql` has `agent_runs` and `agent_sessions` tables, but nothing in
  `sync-worker/src/external/*` writes to them — searches, reads, and discards leave no
  audit trail at all beyond the `changesets` row's own status transitions. Worth flagging before
  anyone relies on the "universal auditability" claim in AGENT-API.md §2.
- **`PlanImport` has no MCP tool.** `mcp-tools.ts` only exposes `SetTranslation` staging
  (`prepare_translations`) over MCP; the entire "one supported end-to-end import" gate-5
  workflow (upload artifact → inspect → PlanImport prepare/commit) is REST-only. An MCP-only
  agent host cannot run the Blackfoot import without a REST-capable escape hatch. Called out in
  the worked example (`docs/api/examples/blackfoot-import.md`, "Using MCP instead of raw REST").
- **`rate_limited` is a fully specified error code with zero enforcement.** Grepped for rate
  limiting anywhere under `sync-worker/src/external/` and `auth-worker/src/routes/`
  ({credentials,changeset-approvals}.ts) — none exists. `get_capabilities` also does not publish
  any rate-limit numbers (§8 open question 3 in AGENT-API.md is still open).
- **`GET /api/v1/external/projects/:projectId/changesets/:id` and `.../commit`/`.../discard`
  authorize by "credential that staged it", not by live role** — `changesets-route.ts` checks
  `cred.credentialId !== cs.credentialId` rather than re-resolving project role for these three
  endpoints (unlike prepare, which does check scope/role). This means a *different* credential
  belonging to the same or another user — even one with a higher live role — cannot view, commit,
  or discard someone else's staged changeset via the external API. Consistent with "the human who
  staged it owns its lifecycle," matching the approval-page authz note above, but worth a second
  look if a future wave wants a maintainer to intervene on another agent's stuck changeset.

## Resolved

- W2-C: one-time human approval assertion (GET/approve/reject) +
  `/approve/:changesetId` SPA page shipped — see commit on
  `swarm/agent-api-w2c-approval` for file list.

### W3-A (permission parity) — PARITY VIOLATION found

- **`prepare` (POST .../changesets) has no role/membership gate.**
  `sync-worker/src/external/prepare.ts::handlePrepare` validates the credential and
  calls `assertCredentialScope` (token-bridge.ts) — which only compares the
  credential's `projectId`/`orgId` against the target project. It never calls
  `resolveProjectRoleShared`. A credential owned by a user who is NOT a project
  member by any path (no project_members / group grant / org membership / creator)
  can still stage a changeset and receive the server-computed effect summary —
  which leaks per-cell existence and added-vs-modified counts for a project the
  user has zero in-app visibility into. Every other exposed operation (reads,
  commit, artifact upload) resolves the LIVE role and denies non-members.
  Documented as `it.fails` in
  `sync-worker/src/__tests__/external-permission-parity.test.ts`
  ("PARITY VIOLATION — prepare lacks a role/membership gate"). Fix: resolve the
  live role in `handlePrepare` and require >= VIEWER (or CONTRIBUTOR, to match the
  commit floor) before staging; then flip the `it.fails` to a plain `it`.
