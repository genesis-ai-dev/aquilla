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
  /** Identity-worker base URL — the DraftCells command (AQU-1186) calls its
   *  internal drafting endpoint with the SYNC_SECRET_KEY shared secret, the
   *  same server-to-server pattern as monday-notify.ts. */
  AUTH_WORKER_URL?: string
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

/** Command kinds that apply a plain row write instead of events, and so carry a
 *  provenance-stamp receipt (ReceiptOnlyReceipt) rather than an event-id list.
 *  The summary names the kind so the human on /approve/:id sees WHICH lifecycle
 *  op they are approving instead of an empty "No changes summarized." box. */
export type ReceiptOnlyCommandKind =
  | 'CreateProject'
  | 'CreateOrg'
  | 'UpdateProjectSettings'
  | 'PatchSettings'
  | 'SetBrief'
  | 'AddOrgMember'
  | 'SetOrgRole'
  | 'RemoveOrgMember'
  | 'RenameProject'
  | 'ArchiveProject'
  | 'UnarchiveProject'
  | 'Membership'

/** Per-kind effect line for an EmitEvents changeset. `testimony` marks
 *  validation kinds (cell.validate / cell.unvalidate) so review UIs render
 *  per-item confirmation and bulk auto-apply excludes them. */
export interface EmitEventsSummaryEntry {
  kind: string
  count: number
  testimony: boolean
}

/** One staged validation/unvalidation, named cell by cell (AQU-1184 guardrail
 *  2). A count alone ("3 cell.validate") is not an approvable plan: endorsing
 *  a translation is testimony, so the approver has to see WHICH cells and
 *  WHAT text they are putting their name to. Server-computed at prepare from
 *  the live projection — never from anything the agent supplied. */
export interface TestimonySummaryEntry {
  kind: 'cell.validate' | 'cell.unvalidate'
  fileId: string
  cellId: string
  /** Target-language lane (absent = the default lane). */
  laneId?: string
  /** The lane's current target text, truncated for display. */
  text: string
  /** True when `text` was cut at TESTIMONY_TEXT_MAX. */
  truncated: boolean
}

/** Effect line for a cell-structure changeset (AQU-1234). Every count is
 *  server-computed from the live chain at prepare, so the human on /approve/:id
 *  sees how many rows actually move — not the agent's claim about it. */
export interface StructureSummaryEntry {
  command: 'InsertCell' | 'DeleteCell' | 'SplitCell'
  fileId: string
  cellsAdded: number
  cellsRemoved: number
  /** Rows re-pointed in the anchor chain so document order survives the edit. */
  cellsReanchored: number
  targetsRemoved: number
  targetsRewritten: number
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
  /** Receipt-only (CreateProject / CreateOrg / UpdateProjectSettings /
   *  PatchSettings / SetBrief / Membership / AddOrgMember / SetOrgRole /
   *  RemoveOrgMember / RenameProject / ArchiveProject / UnarchiveProject)
   *  plus the memory commands (AddExample / AddDecision / RetireExample /
   *  AddNote): the command kind, so the human on /approve/:id sees WHICH
   *  lifecycle op they're approving instead of an empty "No changes
   *  summarized." box (design §2 / blind-approval fix). */
  command?: ReceiptOnlyCommandKind | 'AddExample' | 'AddDecision' | 'RetireExample' | 'AddNote'
  /** AQU-1228 memory commands: the memory path being written or retired, plus
   *  a one-line preview, so the human on /approve/:id sees the actual effect. */
  memoryWrites?: { path: string; action: 'add' | 'retire'; preview: string }[]
  /** CreateProject: the project name being created. RenameProject: the new
   *  name. ArchiveProject / UnarchiveProject: the project's current name, so
   *  the approval box names what is being trashed or restored. */
  projectName?: string
  /** RenameProject: the name being replaced, so the approval box reads as a
   *  before → after rather than a bare new label. */
  previousProjectName?: string
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
  /** CreateProject: the language pair being seeded into settings, when the
   *  command carried one (AQU-1223) — rendered on /approve/:id so a human sees
   *  the configuration they are authorizing, not just the name. `''` (the
   *  source-only shape) is shown as 'none'. */
  newProjectLanguages?: string
  /** CreateOrg: the organization name being created (AQU-1221). */
  orgName?: string
  /** CreateOrg: who will own the new org, in plain language — the credential's
   *  minting user, resolved server-side (an agent can never name someone else).
   *  Rendered on /approve/:id as "Org owner: alice", so the human approving is
   *  told both WHAT is created and WHO ends up owning it. */
  orgOwner?: string
  /** Receipt-only UpdateProjectSettings: the changeset's project id. */
  projectId?: string
  /** UpdateProjectSettings: the pinned settings version this write guards on. */
  ifMatchVersion?: number
  /** UpdateProjectSettings / PatchSettings: one truncated "key → preview" per
   *  top-level settings key being written. SetBrief uses the same shape, keyed
   *  per brief section (`translationBrief.<fieldId>`), so the approval page
   *  renders which sections change without a second summary field. Rendered as
   *  individual lines on the approval page (an object, so the page's flat
   *  number/string filter ignores it — the page reads it explicitly). */
  settingsChanges?: Record<string, string>
  /** EmitEvents: per-kind effect lines (kind, count, testimony flag). */
  events?: EmitEventsSummaryEntry[]
  /** AQU-1185 Membership: one plain-language line per membership change ("Add
   *  alice to proj-a as contributor (400)"), rendered as its own list on the
   *  approval page. A human approving a role grant must be able to read who,
   *  what role, and which project without decoding the command JSON. */
  membershipChanges?: string[]
  /** EmitEvents (AQU-1184): every staged cell.validate / cell.unvalidate,
   *  named individually with the cell's current text. Rendered as its own
   *  section on the approval page (an array, so the page's flat
   *  number/string fact filter ignores it — the page reads it explicitly). */
  testimony?: TestimonySummaryEntry[]
  /** InsertCell / DeleteCell / SplitCell: the one structural effect line. */
  structure?: StructureSummaryEntry
  warnings: ChangesetWarning[]
}

/**
 * Prepare-time ledger for a cell-structure changeset (AQU-1234).
 *
 * One loose shape rather than a union per command: it round-trips through the
 * `summary` JSONB column, and the fields each command uses are documented
 * below. Beyond the usual minted event ids it also carries the pinned parent
 * heads and the CUT TEXT — a split's halves are computed at prepare from the
 * source the pin proves is still live, so commit applies exactly what was
 * approved rather than re-deriving it from whatever the cell says now.
 */
export interface StructurePlan {
  kind: 'InsertCell' | 'DeleteCell' | 'SplitCell'
  /** Delete/Split: the cell being removed or cut. */
  cellId?: string
  /** Delete/Split: that cell's pinned source chain head. */
  sourceParentEventId?: string
  /** Delete: the minted source.cell.delete id. */
  deleteEventId?: string
  /** Delete: the anchor the removed cell's successors inherit. */
  anchorCellId?: string | null
  /** Split: the minted source.cell.commit id that truncates the original. */
  commitEventId?: string
  /** Split: the two halves of the source text, cut at prepare. */
  sourceHead?: string
  sourceTail?: string
  /** Insert/Split: the new cell and its minted source.cell.create id. */
  newCellId?: string
  createEventId?: string
  /** Insert/Split: the new cell's `sequenceIndex`, midway between neighbours. */
  sequenceIndex?: number
  /** Split: the original's `type`, inherited by the second half. */
  newCellType?: string
  /** Rows to re-point, each with its pinned head and minted reorder id. */
  reanchor: { cellId: string; parentEventId: string; eventId: string }[]
  /** Target rows to drop (Delete, and Split with `targets: 'blank'`). */
  targetDeletes?: { lane: string; eventId: string }[]
  /** Split with `targets: 'divide'`: per lane, the pinned target head, the two
   *  halves of the translation, and the minted commit ids for each. */
  targetSplits?: {
    lane: string
    parentEventId: string
    headValue: string
    tailValue: string
    headEventId: string
    tailEventId: string
  }[]
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
  /** SetBrief (receipt-only): the settings version pinned at prepare — the
   *  brief lives in the settings blob, so it takes the same version guard. */
  setBrief?: { version: number }
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
  /** InsertCell / DeleteCell / SplitCell: the whole structural plan — minted
   *  event ids, pinned parent heads, and the prepare-time cut text. */
  structure?: StructurePlan
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
  command: ReceiptOnlyCommandKind
  appliedAt: string
  /** CreateProject: the created project id. UpdateProjectSettings /
   *  PatchSettings / SetBrief / Membership / RenameProject / ArchiveProject /
   *  UnarchiveProject: the project id it wrote. Org membership: the project
   *  the plan was filed under (the write itself is org-level). Absent for
   *  CreateOrg — it creates no project, and the changeset's own project id is
   *  a filing placeholder that never resolves to a row. */
  projectId?: string
  /** UpdateProjectSettings / PatchSettings / SetBrief: the new settings version
   *  after the write. */
  version?: number
  /** Membership: every applied change, in command order. */
  membership?: MembershipReceiptEntry[]
  /** CreateOrg: the created org id (AQU-1221). AQU-1235: the org the
   *  membership change landed in. */
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
