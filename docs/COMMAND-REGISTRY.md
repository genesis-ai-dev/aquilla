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
**EmitEvents** (structural, 200 — floor is per inner event kind; testimony kinds flagged) ·
**InviteMember / SetRole / RemoveMember** (governance, 600 — always ask-mode; see §2).
AQU-1228 adds the Living Memory writes: **AddExample** / **AddDecision** / **AddNote**
(structural, 400) and **RetireExample** (structural, 500).

### Membership — InviteMember / SetRole / RemoveMember (AQU-1185)

```ts
{ kind: 'InviteMember', projectId: string, username: string, role: number }
{ kind: 'SetRole',      projectId: string, username: string, role: number }
{ kind: 'RemoveMember', projectId: string, username: string }
```

Receipt-only (a `project_members` row write, not events). Membership kinds batch with each
other — max 25, one command per person — but never with another kind. Prepare **forces
ask-mode** regardless of the credential's mode: every membership change a machine proposes
passes a human at `/approve/:id`, which lists one plain-language line per change.

Gates, enforced identically at prepare and at commit against the caller's **live** role:

| Rule | Denial `details.code` |
| --- | --- |
| caller's effective project role ≥ MAINTAINER (600) | (`requiredRole: 600`) |
| cannot grant a role above your own | `role_above_caller` |
| cannot act on yourself (covers self-elevation) | `self_target` |
| below OWNER, cannot touch anyone whose **effective** role ≥ yours | `target_outranks_caller` |
| InviteMember on an existing direct member | `already_member` (409) |
| SetRole / RemoveMember with no direct member row | `not_a_direct_member` (409) |

The target cap reads the target's **effective** (max-wins) role, not the direct
`project_members.role_level` the UI compares against — so a project OWNER who holds the
project through the org or creator path, and therefore has no direct row, cannot be removed
by a MAINTAINER's agent.

Drift at commit is all-or-nothing: a plan whose end-state a human already applied is
`superseded`, any other movement is `stale`, and nothing is written either way. Target user
ids are pinned at prepare, so a username reassigned between prepare and commit is drift
rather than a new target. The committed receipt carries the credential id plus every applied
change (`kind`, `userId`, `username`, `role`, `previousRole`) as the audit record.

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
  `assignment.create`, `assignment.reassign`, `assignment.unassign`,
  `term.create`, `term.update`, `term.delete`, `term.approve`, `term.reject`.
  († testimony: allowed to stage, but the summary marks them `testimony: true` so review UIs
  render per-item confirmation; they are excluded from any future bulk auto-apply.)
- **Terminology (AQU-1179).** Project-level: no `fileId`/`cellId` on the envelope (rejected if
  supplied — the engine routes them under the project sentinel), concept id rides the payload.
  The static floor is CONTRIBUTOR, but prepare mirrors `termbase-authority.ts`'s conditional
  raise: every BINDING write — `term.create` with `status: 'active'`, and every update / delete /
  approve / reject — is checked against the org's `termbaseEditMinRole` (default 500), so a plan
  the caller could never commit is denied rather than staged. `status: 'draft'` on create is a
  suggestion and stays at CONTRIBUTOR. `term.update` may not carry `status` (approve/reject are
  their own kinds, so the audit trail keeps "edited" apart from "made binding"); a `term.create`
  naming a live concept is rejected rather than upserted over it; a `term.approve` of a non-draft
  is rejected rather than applied as a projection no-op.
- Explicitly NOT allowlisted: `target.cell.commit` (use SetTranslation), `source.cell.*`,
  `cell.audio.*` (use LinkMedia), reorders/retimes/mirrors, `file.timing.set`, `file.create`,
  cell structure (split/merge/insert/delete), membership, and project lifecycle. Rules and Living
  Memory have no event kinds at all — rules live in the settings blob (PatchSettings), memory
  behind auth-worker's agent-memory API — so they cannot come through this door until they are
  event-sourced.
- Summary gains `events: { kind, count, testimony, label }[]` alongside existing fields. `label`
  is a server-computed plain-language effect line ("Approve a glossary term — enforced for
  everyone on the project"); the approval page renders it, falling back to `kind × count` for
  changesets staged before it existed. Adding a kind to the allowlist means adding its phrasing
  to `emitKindEffectLabel` — a reviewer approves the effect, not the event name.

### RenameFile — file label management (AQU-1182)

- Params `{ fileId, name }`; batchable within a RenameFile-only changeset; floor CONTRIBUTOR
  400 (`REQUIRED_ROLE['file.rename']` — the UI's own floor for the same action).
- **Sugar over EmitEvents, by construction.** Prepare desugars the batch into the equivalent
  `file.rename` `EmitEvents` command and delegates to that engine; nothing here compiles an
  event of its own. Consequence to know: the stored plan (and the changeset a caller reads
  back) holds `file.rename` events, not a `RenameFile` entry.
- `name` is trimmed, 1–256 chars; whitespace-only is rejected. File delete is NOT given a named
  command — soft-delete/trash semantics are in flux (AQU-272), so it stays behind the raw
  `EmitEvents` door where the caller opts into current semantics explicitly.

### Project lifecycle — RenameProject / ArchiveProject / UnarchiveProject (AQU-1182)

- Receipt-only row writes in the `CreateProject` family (D8) — no events, receipt is a
  provenance stamp. Each is the **sole command** in its changeset and its `projectId` must equal
  the changeset's project.
- Floors mirror auth-worker `routes/projects.ts` exactly: `RenameProject` MAINTAINER 600
  (`PATCH /:projectId`), `ArchiveProject` / `UnarchiveProject` OWNER 700
  (`POST` / `DELETE /:projectId/archive`). Re-resolved live at prepare AND commit.
- **Forced ask-mode** at prepare for all three, regardless of credential/request mode
  (CreateProject's precedent) — every agent-initiated project-lifecycle change passes through
  `/approve/:id`. `RenameFile` is not forced: it is a CONTRIBUTOR-floor label edit and follows
  the normal autonomy ladder like `SetTranslation`.
- Role resolution uses `resolveProjectRoleIncludingArchivedShared`: the ordinary shared
  resolver returns null for every archived project, which would make `UnarchiveProject`
  unreachable. Same twin auth-worker's archive endpoints use; ordinary authority is untouched.
- End-state check (deterministic, exact): already-archived / not-archived / already-named-that
  is `validation_failed` at prepare and `plan_stale` + `details.status: "superseded"` at
  commit. A crash-retry (`status = 'committing'`) skips it and re-applies idempotently; the
  archive write keeps `AND archived_at IS NULL` so a retry cannot re-stamp a newer timestamp.
- Archive/unarchive best-effort notify the `ProjectSync` DO (`archive-broadcast.ts`), matching
  the UI path; a failed broadcast never fails an applied commit.
- Project DELETE is never exposed on any agent surface: archive is recoverable, delete is not.

### Living Memory writes (AQU-1228) — AddExample / AddDecision / AddNote / RetireExample

```ts
{ kind: 'AddExample',    slug, source, target, note?, rationale? }  // examples/<slug>.md
{ kind: 'AddDecision',   slug, decision, rationale? }               // decisions/<slug>.md
{ kind: 'AddNote',       fileId, cellId, note, rationale? }         // notes/<file>/<cell>-<digest>.md
{ kind: 'RetireExample', slug, rationale? }                         // archives examples/<slug>.md
```

- **Not EmitEvents.** Living Memory is not event-sourced — it is the `agent_memories` table
  (`db/shared/agent-memory.ts`), path-keyed per project with its own
  `proposed → approved → archived` lifecycle. So these are **receipt-only** commands on the
  PatchSettings pattern: sole command, no compiled events, no cell preconditions.
- **Two gates, one approval.** The changeset gate (ask-mode human confirmation) stands in for
  the Memory-tab review — but only at the authority that review requires. A commit lands the
  memory `approved` iff the changeset carried a real confirmation AND the confirming user
  holds PROJECT_LEAD(500)+. Otherwise (act mode, or a contributor-level approver) it lands
  `proposed` and still needs the in-app review. The receipt's `memoryStatus` reports which.
- **Floors:** adding is the propose tier (CONTRIBUTOR 400, matching auth-worker's
  `POST /agent-memory`); retiring is the review tier (PROJECT_LEAD 500, matching that route's
  review endpoint) — un-publishing memory the whole project's copilot reads is a review act.
- **Retrieval follows for free.** `buildMemoryContext` selects approved memories only, so
  approving adds an entry to the next copilot prompt and retiring removes it. No retrieval
  code changes.
- **Human-edited rows are untouchable** through this surface (permission_denied, both for an
  overwriting add and for a retire) — adversarial-panel B1/B2.
- **Superseding archives, never mutates**: re-using a slug archives the prior version.
  `AddNote`'s path carries a digest of the exact `(fileId, cellId)` so two cells whose ids
  slugify alike never share a note slot. The cell must exist at prepare (`not_found`).
- **Idempotency:** the `agent_memories` row id is minted at prepare (`plannedIds.memory`), so
  a crash-retry re-finds its own proposal rather than inserting a duplicate.
- Summary gains `memoryWrites: { path, action, preview }[]`; the receipt is
  `MemoryWriteReceipt` (`memoryPath`, `memoryStatus`, and a `note` when review is pending).

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
