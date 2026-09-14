// Shared types for the changeset engine.

import type { EventsRouteEnv } from '../events/route'
import type { Command } from './commands'
import type { CellPrecondition } from './preconditions'

/** Environment for the external API — a superset of the /events perimeter env
 *  (the compiled events are routed back through handleEventsWriteRequest). */
export type ExternalEnv = EventsRouteEnv & {
  /** Base URL for the ask-mode approval deep link. */
  BASE_URL?: string
  /** R2 media/original-import blob bucket (artifact bytes). */
  SNAPSHOTS?: R2Bucket
  /** Optional R2 key prefix for PR/staging isolation (mirrors audio.ts). */
  R2_KEY_PREFIX?: string
}

/** A skipped / warned item — nothing is ever silently dropped (§3). */
export interface ChangesetWarning {
  code: 'missing_cell' | 'duplicate_command' | 'stale_pin' | 'rejected' | 'duplicate_file'
  fileId: string
  cellId: string
  message: string
}

/** Provenance channel a commit arrived on (AQU-926 command registry §3):
 *  'mcp' = the MCP adapter's synthetic in-process request, 'rest' = a direct
 *  PAT REST call, 'app' = the session-token routes (in-app agent harness).
 *  Server-assigned — the session routes pass 'app' explicitly; external
 *  callers can never claim it via headers. */
export type ProvenanceChannel = 'mcp' | 'rest' | 'app'

/** Per-kind effect line for an EmitEvents changeset. `testimony` marks
 *  validation kinds (cell.validate / cell.unvalidate) so review UIs render
 *  per-item confirmation and bulk auto-apply excludes them. */
export interface EmitEventsSummaryEntry {
  kind: string
  count: number
  testimony: boolean
}

/** Server-computed effect summary — facts come from the plan, not the agent.
 *  SetTranslation changesets populate translations*; PlanImport changesets
 *  populate filesCreated/sourceCellsAdded/artifactLinked. */
export interface ChangesetSummary {
  translationsAdded?: number
  translationsModified?: number
  /** PlanImport: 1 (a changeset creates exactly one file). */
  filesCreated?: number
  /** PlanImport: number of source cells the file.create seeds. */
  sourceCellsAdded?: number
  /** PlanImport: target variants added across explicit lanes. */
  targetVariantsAdded?: number
  /** PlanImport: the artifact id linked to the created file, when supplied. */
  artifactLinked?: string
  /** LinkMedia: number of cells an audio artifact is attached to. */
  mediaLinked?: number
  /** Receipt-only (CreateProject / UpdateProjectSettings / PatchSettings): the
   *  command kind, so the human on /approve/:id sees WHICH lifecycle op they're
   *  approving instead of an empty "No changes summarized." box (design §2 /
   *  blind-approval fix). */
  command?:
    | 'CreateProject'
    | 'UpdateProjectSettings'
    | 'PatchSettings'
    | 'AddOrgMember'
    | 'SetOrgRole'
    | 'RemoveOrgMember'
    | 'AddExample'
    | 'AddDecision'
    | 'RetireExample'
    | 'AddNote'
  /** AQU-1228 memory commands: the memory path being written or retired, plus
   *  a one-line preview, so the human on /approve/:id sees the actual effect. */
  memoryWrites?: { path: string; action: 'add' | 'retire'; preview: string }[]
  /** CreateProject: the project name being created. */
  projectName?: string
  /** CreateProject: the definitive new project id. */
  newProjectId?: string
  /** CreateProject: the target org id as a string, or 'personal' for org-less.
   *  Org-membership commands: the target org's name + id, for the approval page. */
  targetOrg?: string
  /** AQU-1235: the username being added / changed / removed. */
  orgMemberUsername?: string
  /** AQU-1235: the org role the member is being moved TO, as a role name. */
  orgMemberNewRole?: string
  /** AQU-1235: the org role the member holds TODAY ('not a member' for an add). */
  orgMemberCurrentRole?: string
  /** Receipt-only UpdateProjectSettings: the changeset's project id. */
  projectId?: string
  /** UpdateProjectSettings: the pinned settings version this write guards on. */
  ifMatchVersion?: number
  /** UpdateProjectSettings / PatchSettings: one truncated "key → preview" per
   *  top-level settings key being written. Rendered as individual lines on the
   *  approval page (an object, so the page's flat number/string filter ignores
   *  it — the page reads it explicitly). */
  settingsChanges?: Record<string, string>
  /** EmitEvents: per-kind effect lines (kind, count, testimony flag). */
  events?: EmitEventsSummaryEntry[]
  warnings: ChangesetWarning[]
}

/** Prepare-time id ledger (W1-B, design §4). All event/file/cell ids a commit
 *  needs are minted at prepare and stored in the plan, so a crash-and-retry
 *  re-posts IDENTICAL ids and the /events idempotency layer absorbs the
 *  duplicates instead of a fresh mint producing duplicate events/files. Held
 *  alongside — not inside — the effect summary; persisted in the `summary`
 *  JSONB column and split back out on load (store.ts) so the public summary
 *  shape stays clean and the digest (over commands + preconditions) is
 *  unaffected. */
export interface PlannedEventIds {
  /** SetTranslation: minted target.cell.commit event id per target cell — one
   *  per resolved precondition. Stored as a list (not a cellKey-keyed object):
   *  cellKey's NUL separator is not a legal jsonb object key. `laneId` is the
   *  target-language lane (absent = default lane, AQU-538). */
  setTranslation?: { fileId: string; cellId: string; laneId?: string; eventId: string }[]
  /** PlanImport: the created file id, its file.create event id, and one
   *  source.cell.create {cellId, eventId} per plan cell (cellId minted here
   *  when the plan cell omitted its own id), in plan-cell order. */
  planImport?: {
    fileId: string
    fileEventId: string
    /** Soft-hide/reveal events keep a partial multi-chunk import invisible. */
    hideEventId?: string
    revealEventId?: string
    cells: { cellId: string; eventId: string; variantEventIds?: string[] }[]
    /** Stable id for the artifact_bindings row when an artifact is supplied. */
    artifactBindingId?: string
  }
  /** W2-A CreateProject (receipt-only): the definitive project id (minted /
   *  fixed at prepare so a crash-retry re-applies the SAME id, not a fresh one)
   *  and the resolved target org id (null for a personal/org-less project). */
  createProject?: { projectId: string; orgId: number | null }
  /** W2-A UpdateProjectSettings (receipt-only): the settings version the plan
   *  pinned at prepare (the commit-time version guard, i.e. the drift check for
   *  a versioned blob rather than a per-cell head). */
  updateProjectSettings?: { version: number }
  /** PatchSettings (receipt-only): the settings version pinned at prepare —
   *  same guard semantics as updateProjectSettings. */
  patchSettings?: { version: number }
  /** AQU-1235 org membership (receipt-only): the resolved target org + user
   *  (pinned at prepare so commit writes the SAME identity the human approved,
   *  never a re-resolution of the username), plus the role the target held at
   *  prepare — the drift guard — and the role being written (absent for a
   *  removal). */
  orgMember?: {
    orgId: number
    targetUserId: string
    previousRole: number | null
    role?: number
  }
  /** AQU-1228 memory commands: the resolved memory path, and (for the adding
   *  kinds) the pre-minted agent_memories row id, so a crash-retry re-finds
   *  its own proposal instead of inserting a second one. RetireExample writes
   *  no row, so it carries the path only. */
  memory?: { path: string; memoryId?: string }
  /** EmitEvents: one entry per plan event, in event order — the compiled event
   *  id plus any payload ids minted at prepare (comment.create's commentId /
   *  assignment.create's assignmentId when the caller omitted them), so a
   *  crash-retry re-posts IDENTICAL ids and payloads. */
  emitEvents?: { eventId: string; commentId?: string; assignmentId?: string }[]
  /** LinkMedia: one entry per attach command — the target (fileId, cellId), the
   *  audio artifact id, and the minted cell.audio.attach + cell.audio.select
   *  event ids. A crash-and-retry re-posts these IDENTICAL ids, so the /events
   *  idempotency layer dedupes the audio events instead of double-attaching. */
  linkMedia?: {
    fileId: string
    cellId: string
    artifactId: string
    attachEventId: string
    selectEventId: string
  }[]
}

/** Execution receipt recorded on commit. */
export interface ChangesetReceipt {
  eventIds: string[]
  appliedCount: number
  staleCount: number
  warnings: ChangesetWarning[]
  committedAt: string
  /** PlanImport: the created file's id. */
  fileId?: string
}

/** W2-A receipt for the receipt-only project-lifecycle commands (spec §2 D8).
 *  These apply a plain row write, not events, so the event-shaped
 *  ChangesetReceipt does not fit — the receipt is a provenance stamp instead. */
export interface ReceiptOnlyReceipt {
  credentialId: string
  channel: ProvenanceChannel
  changesetId: string
  command:
    | 'CreateProject'
    | 'UpdateProjectSettings'
    | 'PatchSettings'
    | 'AddOrgMember'
    | 'SetOrgRole'
    | 'RemoveOrgMember'
  appliedAt: string
  /** CreateProject: the created project id. UpdateProjectSettings /
   *  PatchSettings: the updated project id. Org membership: the project the
   *  plan was filed under (the write itself is org-level). */
  projectId: string
  /** UpdateProjectSettings / PatchSettings: the new settings version after the
   *  write. */
  version?: number
  /** AQU-1235: the org the membership change landed in. */
  orgId?: number
  /** AQU-1235: the user whose membership changed. */
  targetUserId?: string
  /** AQU-1235: the org role held before the change (null/absent = not a member). */
  previousRole?: number
  /** AQU-1235: the org role written (absent for a removal). */
  role?: number
}

/** AQU-1228 receipt for the Living Memory write commands. Also receipt-only (a
 *  row write, not events), but it reports WHERE the memory landed and in WHAT
 *  state — `proposed` still needs an in-app review before the copilot reads it,
 *  so the caller must never have to infer that from silence. */
export interface MemoryWriteReceipt {
  credentialId: string
  channel: ProvenanceChannel
  changesetId: string
  command: 'AddExample' | 'AddDecision' | 'RetireExample' | 'AddNote'
  appliedAt: string
  projectId: string
  /** The `agent_memories.path` written or retired. */
  memoryPath: string
  memoryStatus: 'proposed' | 'approved' | 'archived'
  /** Present when the write still needs a human review to take effect. */
  note?: string
}

/** The full stored plan, as persisted in `changesets`. */
export interface StoredChangeset {
  id: string
  projectId: string
  createdByUserId: string
  credentialId: string
  autonomyMode: 'ask' | 'act'
  /** `committing` is the mid-commit state (W1-B, §4): set when apply starts,
   *  flipped to `committed` at the end. A changeset found in `committing` is a
   *  crash-retry — commit re-enters it, re-posts the stored ids, and finishes.
   *  `superseded` (P1 §1) is a HEALTHY terminal outcome: the plan's end-state
   *  already existed because a human did the work. It is never `stale`
   *  (preconditions drifted some other way) and never `expired` (nobody
   *  acted) — merging it into either would inflate an unhealthy count with a
   *  healthy case. */
  status:
    | 'staged'
    | 'committing'
    | 'committed'
    | 'discarded'
    | 'stale'
    | 'superseded'
    | 'expired'
  commands: Command[]
  preconditions: CellPrecondition[]
  summary: ChangesetSummary
  /** Prepare-time id ledger (W1-B). Null for changesets staged before this
   *  landed — commit falls back to minting for backward compat. */
  plannedIds: PlannedEventIds | null
  digest: string
  receipt: ChangesetReceipt | ReceiptOnlyReceipt | MemoryWriteReceipt | null
  confirmationId: string | null
  createdAt: string
  expiresAt: string
  committedAt: string | null
}
