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
  warnings: ChangesetWarning[]
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
  status: 'staged' | 'committed' | 'discarded' | 'stale' | 'expired'
  commands: Command[]
  preconditions: CellPrecondition[]
  summary: ChangesetSummary
  digest: string
  receipt: ChangesetReceipt | null
  confirmationId: string | null
  createdAt: string
  expiresAt: string
  committedAt: string | null
}
