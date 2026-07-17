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
  /** PlanImport: the artifact id linked to the created file, when supplied. */
  artifactLinked?: string
  /** LinkMedia: number of cells an audio artifact is attached to. */
  mediaLinked?: number
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
    cells: { cellId: string; eventId: string }[]
  }
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
  receipt: ChangesetReceipt | null
  confirmationId: string | null
  createdAt: string
  expiresAt: string
  committedAt: string | null
}
