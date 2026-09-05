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
  /** Receipt-only (CreateProject / UpdateProjectSettings / PatchSettings /
   *  Membership): the command kind, so the human on /approve/:id sees WHICH
   *  lifecycle op they're approving instead of an empty "No changes
   *  summarized." box (design §2 / blind-approval fix). */
  command?: 'CreateProject' | 'UpdateProjectSettings' | 'PatchSettings' | 'Membership'
  /** CreateProject: the project name being created. */
  projectName?: string
  /** CreateProject: the definitive new project id. */
  newProjectId?: string
  /** CreateProject: the target org id as a string, or 'personal' for org-less. */
  targetOrg?: string
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
  /** AQU-1185 Membership: one plain-language line per membership change ("Add
   *  alice to proj-a as contributor (400)"), rendered as its own list on the
   *  approval page. A human approving a role grant must be able to read who,
   *  what role, and which project without decoding the command JSON. */
  membershipChanges?: string[]
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
  /** EmitEvents: one entry per plan event, in event order — the compiled event
   *  id plus any payload ids minted at prepare (comment.create's commentId /
   *  assignment.create's assignmentId when the caller omitted them), so a
   *  crash-retry re-posts IDENTICAL ids and payloads. */
  emitEvents?: { eventId: string; commentId?: string; assignmentId?: string }[]
  /** AQU-1185 Membership: the resolved target user id per command, in command
   *  order. Pinned at prepare so the commit writes the PERSON the human
   *  approved — a username that has since been reassigned to another account
   *  is drift (plan_stale), not a target. */
  membership?: { username: string; userId: string }[]
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

/** AQU-1185: one applied membership change, recorded on the receipt so the
 *  audit trail is self-contained — the changeset row already carries the
 *  credential id, and this says exactly what that credential did to whom. */
export interface MembershipReceiptEntry {
  kind: 'InviteMember' | 'SetRole' | 'RemoveMember'
  userId: string
  username: string
  /** The role granted (absent for RemoveMember). */
  role?: number
  /** The target's direct role before the write; null when they had no row. */
  previousRole: number | null
}

/** W2-A receipt for the receipt-only project-lifecycle commands (spec §2 D8).
 *  These apply a plain row write, not events, so the event-shaped
 *  ChangesetReceipt does not fit — the receipt is a provenance stamp instead. */
export interface ReceiptOnlyReceipt {
  credentialId: string
  channel: ProvenanceChannel
  changesetId: string
  command: 'CreateProject' | 'UpdateProjectSettings' | 'PatchSettings' | 'Membership'
  appliedAt: string
  /** CreateProject: the created project id. UpdateProjectSettings /
   *  PatchSettings / Membership: the affected project id. */
  projectId: string
  /** UpdateProjectSettings / PatchSettings: the new settings version after the
   *  write. */
  version?: number
  /** Membership: every applied change, in command order. */
  membership?: MembershipReceiptEntry[]
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
  receipt: ChangesetReceipt | ReceiptOnlyReceipt | null
  confirmationId: string | null
  createdAt: string
  expiresAt: string
  committedAt: string | null
}
