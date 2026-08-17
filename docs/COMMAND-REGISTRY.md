# Command Registry — P0 contract (AQU-CMDREG)

Implements §6–7 of `docs/AGENT-CAPABILITY-AUDIT.md`: one command vocabulary + one staging/commit
engine for both the in-app agent and the external Agent API. P0 is **additive** — the external
surface keeps its behavior; the in-app agent gains a changeset path beside the legacy proposal
path (legacy retirement is a follow-up, not this change).

This file is the cross-package contract. The three work streams (sync-worker, auth-worker, SPA)
build against it independently; do not drift from the shapes below without updating this file.

## 1. Shared catalog — `db/shared/command-catalog.ts` (owner: sync-worker stream)

Dependency-free metadata importable by BOTH workers (precedent: `db/shared/agent-memory.ts`).

```ts
export type CommandTier = 'prepared' | 'structural' | 'testimony' | 'governance'

export interface CommandCatalogEntry {
  kind: string            // 'SetTranslation' | 'PlanImport' | ... | 'EmitEvents' | 'PatchSettings'
  title: string           // 'Set translation'
  oneLiner: string        // ≤90 chars, for the role-filtered prompt index
  minRoleLevel: number    // static floor for index filtering (dynamic checks stay in prepare)
  tier: CommandTier
  agentReachable: boolean // false = never offered to any agent surface (governance)
  paramsDoc: string       // L2 body: params, gotchas, one worked example (markdown)
}

export const COMMAND_CATALOG: readonly CommandCatalogEntry[]
export function catalogForRole(level: number): CommandCatalogEntry[]
export function catalogIndexLines(level: number): string[]  // '- EmitEvents (400+): stage …'
export function describeCommand(kind: string): CommandCatalogEntry | null
```

v1 entries: SetTranslation (prepared, 400) · LinkMedia (prepared, 400) · PlanImport (structural,
500) · CreateProject (structural, 600-org) · UpdateProjectSettings (structural, 600 — oneLiner
says "deprecated: prefer PatchSettings") · **PatchSettings** (structural, 500) ·
**EmitEvents** (structural, 200 — floor is per inner event kind; testimony kinds flagged).

## 2. New commands (owner: sync-worker stream)

### PatchSettings — field-scoped settings write

```ts
{ kind: 'PatchSettings', projectId: string,
  ops: { key: string; value: unknown }[],   // top-level settings keys, value replaces key
  ifMatchVersion: number }
```

- Sole command in its changeset. Version-guarded like UpdateProjectSettings (plan_stale on drift),
  reusing `updateProjectSettingsShared` merge semantics per key (via the additive
  `patchProjectSettingsShared` in `db/shared/projects.ts`). One op per key — a duplicate key is
  `validation_failed` (a settings op is authored intent, not a loop batch; last-wins would hide a bug).
- Per-key floors: `terminology` → org `termbaseEditMinRole` (read `org_settings`, default 500);
  everything else 600 (MAINTAINER).
- **POLICY_SETTINGS_KEYS** (exported const) always rejected with `permission_denied`:
  `agentMemoryAutonomy`, `validationRoleFloor`, `validationNamedUsers`, `validationCount`,
  `validationCountAudio`, `allowSelfValidation`, `harmonize_min_role`, `contributeToGlobalTm`.
- `UpdateProjectSettings` (deprecated, kept): now rejects when any POLICY key's value would
  CHANGE vs the live blob (equal pass-through stays valid — existing round-trip callers keep
  working).

### EmitEvents — generalized event staging

```ts
{ kind: 'EmitEvents',
  events: { kind: string; fileId?: string; cellId?: string; laneId?: string;
            payload?: Record<string, unknown> }[] }
```

- Sole command in its changeset (one command already batches many events); max 200 events.
- Compiles each event through the same precondition/parent-resolution doctrine as
  SetTranslation, then routes through the `/events` perimeter at commit (same internal token
  bridge). Floors per inner kind from `REQUIRED_ROLE` (role-policy — single source of truth);
  changeset floor = max over events; foreign unvalidate / foreign comment mutation add the
  perimeter's dynamic MAINTAINER bump at prepare. Every allowed kind is non-chain-mutating, so
  compiled events carry `parentId: null`; the head-referencing kinds (validate/unvalidate/
  backtranslation/repin) pin the live head as standard CellPreconditions instead — their pin
  payload fields (`editEventId`/`targetEventId`/`sourceEventId`/`expectedTargetEventId`) are
  SERVER-RESOLVED at prepare and rejected if caller-supplied. Every referenced
  cell/comment/file/assignment must exist at prepare; one bad reference rejects the whole plan
  (`validation_failed` naming the index — no silent skips), and existence is re-checked on the
  first commit attempt (plan_stale).
- **ALLOWED_EMIT_KINDS v1** (exported const — start here, shrink rather than guess if a kind's
  chain semantics aren't cleanly resolvable at prepare):
  `comment.create`, `comment.edit`, `comment.delete`, `comment.resolve`,
  `cell.waive`, `cell.unwaive`, `cell.validate`†, `cell.unvalidate`†,
  `cell.backtranslation.set`, `target.cell.repin`, `file.rename`, `file.delete`, `file.restore`,
  `assignment.create`, `assignment.reassign`, `assignment.unassign`.
  († testimony: allowed to stage, but the summary marks them `testimony: true` so review UIs
  render per-item confirmation; they are excluded from any future bulk auto-apply.)
- Explicitly NOT in v1: `target.cell.commit` (use SetTranslation), `source.cell.*`,
  `cell.audio.*` (use LinkMedia), reorders/retimes/mirrors, `file.timing.set`, `file.create`.
- Summary gains `events: { kind, count, testimony }[]` alongside existing fields.

## 3. Session principal + routes (owner: sync-worker stream)

- Principal: reuse `ApiCredentialContext` shape with sentinel
  `{ id: 'session', userId, mode: 'ask', orgId: null, projectId: null }` (precedent:
  agent-artifacts writes `credential_id = 'session'`). `changesets.credential_id` /
  `changeset_confirmations.credential_id` store `'session'` — no migration needed.
- Extract the post-auth cores of `handlePrepare` / commit so both the external
  (PAT bearer) entrypoints and new session entrypoints share them. External behavior unchanged
  (existing tests are the guard).
- Provenance channel: extend `'mcp' | 'rest'` with `'app'`. Session commits stamp
  `human_authority: { user_id, credential_id: 'session' }`, `channel: 'app'`,
  `autonomy_mode: 'ask'`.
- **New routes** (session sync-token auth via `verifyTokenForProject(token, projectId,
  env.SYNC_SECRET_KEY)`; only the creator (`created_by_user_id === token user`) may read/act):
  - `POST /api/v1/changesets/:projectId` — prepare. Body `{ commands, id? }`; autonomy forced
    `'ask'`. Response = existing `changesetToResponse` shape.
  - `GET  /api/v1/changesets/:projectId?status=&limit=` — list caller's changesets, newest
    first, cap 50.
  - `GET  /api/v1/changesets/:projectId/:changesetId` — status.
  - `POST /api/v1/changesets/:projectId/:changesetId/commit` — shared commit core; ask-mode
    confirmation consumption (confirmation minted by auth-worker approve route, unchanged).
  - `POST /api/v1/changesets/:projectId/:changesetId/discard`.
- `get_capabilities` (MCP) adds `commands`: role-agnostic catalog index (kind, title, tier,
  minRoleLevel) + note that `describe_command` exists (MCP tool addition is P3; do not add it
  to MCP in this change).

## 4. Harness (owner: auth-worker stream)

- `mintSyncTokenForUser(...)`: extract the mint core from `routes/sync-token.ts` into a shared
  helper used by both the route and the harness (freeze checks preserved). Harness reaches
  sync-worker over HTTP: reuse the existing auth-worker→sync-worker transport pattern if one
  exists (see `services/sync-worker-notify.ts` et al.); otherwise add `SYNC_WORKER_URL` var
  (wrangler configs + `scripts/dev-stack.ts` wiring + docs).
- New tools in `buildTools` (both **budgeted** like `propose`):
  - `propose_command { commands: CommandInput[], changesetId? }` → pre-validate against catalog
    (agentReachable, static floor vs run role — friendlier model feedback), POST prepare,
    emit frame (below), return compact verdict
    `{ changesetId, status, digest, summary: string, warnings?: string[] }`.
    Tool description: "stages a changeset the user reviews and applies in-app — do not poll".
  - `describe_command { kind }` (free, unbudgeted) → catalog `paramsDoc`.
- Schema card: append a role-filtered command index (`catalogIndexLines(roleLevel)`) — one line
  per command, in the tools-contract section; plus one sentence pointing at `describe_command`.
- SSE frame (extend existing union member — additive optional fields only):
  `{ type: 'changeset.staged', runId, changesetId, approvalUrl, summary, cellCount,
     digest?, tier?, kinds?: string[] }`
- Quick fix: `draft` tool schema text says "default 20, cap 50" but the implementation caps at
  10 (`tools/draft.ts` DEFAULT_LIMIT/MAX_LIMIT) — align the schema text to 10.

## 5. SPA (owner: SPA stream)

- `src/lib/agent/protocol.ts`: add the optional `digest` / `tier` / `kinds` fields to the
  `changeset.staged` frame.
- ChangesetCard becomes a live review card for freshly staged changesets:
  - Load: `GET {VITE_AUTH_BASE}/api/v2/changesets/:id/approval` (existing session route) →
    summary + per-cell before/after diffs.
  - **Approve & apply**: `POST .../approve { digest }` (auth-worker) then
    `POST {sync}/api/v1/changesets/:projectId/:changesetId/commit` (sync token — reuse the
    outbox flusher's token acquisition) → render receipt → invalidate/revalidate affected reads.
  - **Reject**: `POST .../reject`.
  - Status chip: staged / committing / committed / discarded / stale / expired.
- Testimony rendering: if `tier === 'testimony'` or summary marks testimony events, the card
  requires per-item confirmation checkboxes before Approve & apply is enabled (no bulk).
- Legacy PlanImport timeline rendering of `changeset.staged` frames must keep working.
- RTL tests: card states + approve flow against a realistic prepare/approval fixture
  (producer→consumer contract per AGENTS.md #12).

## 6. Guardrails (all streams)

- TypeScript, no `any`; hand validation (no zod); files ≤ ~500 lines; match local idiom.
- Worker tests per package (`cd sync-worker && npm test`, `cd auth-worker && npm test`); SPA
  tests via root `pnpm test`. Do not run the full e2e suite; agent journeys are `*.spec.ts`
  (expensive suite), not smoke — no new smoke files for this change.
- External API behavior is frozen: existing external tests must pass unmodified (except where a
  test asserts the exact UpdateProjectSettings policy-key behavior this change introduces).
- Every stream records its test-impact analysis (AGENTS.md #16) in its final report.
