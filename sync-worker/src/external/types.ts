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
  /** Receipt-only (CreateProject / UpdateProjectSettings): the command kind, so
   *  the human on /approve/:id sees WHICH lifecycle op they're approving instead
   *  of an empty "No changes summarized." box (design §2 / blind-approval fix). */
  command?: 'CreateProject' | 'UpdateProjectSettings'
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
  /** UpdateProjectSettings: one truncated "key → preview" per top-level settings
   *  key being written. Rendered as individual lines on the approval page (an
   *  object, so the page's flat number/string filter ignores it — the page reads
   *  it explicitly). */
  settingsChanges?: Record<string, string>
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
   *  cellKey's NUL separator is not a legal jsonb object key. */
  setTranslation?: { fileId: string; cellId: string; eventId: string }[]
  /** PlanImport: the created file id, its file.create event id, and one
   *  source.cell.create {cellId, eventId} per plan cell (cellId minted here
   *  when the plan cell omitted its own id), in plan-cell order. */
  planImport?: {
    fileId: string
    fileEventId: string
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
  channel: 'mcp' | 'rest'
  changesetId: string
  command: 'CreateProject' | 'UpdateProjectSettings'
  appliedAt: string
  /** CreateProject: the created project id. UpdateProjectSettings: the updated
   *  project id. */
  projectId: string
  /** UpdateProjectSettings: the new settings version after the write. */
  version?: number
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
   *  crash-retry — commit re-enters it, re-posts the stored ids, and finishes. */
  status: 'staged' | 'committing' | 'committed' | 'discarded' | 'stale' | 'expired'
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
