// Changeset row persistence helpers.

import type { Command } from './commands'
import type { CellPrecondition } from './preconditions'
import type {
  ChangesetReceipt,
  MemoryWriteReceipt,
  ChangesetSummary,
  PlannedEventIds,
  ReceiptOnlyReceipt,
  StoredChangeset,
} from './types'

/** JSONB columns arrive parsed (postgres.js / PGlite) or as text — handle both. */
function parseJson<T>(v: unknown): T {
  if (v == null) return v as T
  if (typeof v === 'string') return JSON.parse(v) as T
  return v as T
}

/** TIMESTAMPTZ arrives as Date (drivers) or string — normalize to ISO. */
function toIso(v: unknown): string {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString()
  // PGlite may hand back an ISO-ish string already.
  return new Date(v as string).toISOString()
}

interface ChangesetRow {
  id: string
  project_id: string
  created_by_user_id: string
  credential_id: string
  autonomy_mode: string
  status: string
  commands: unknown
  preconditions: unknown
  summary: unknown
  digest: string
  receipt: unknown
  confirmation_id: string | null
  created_at: unknown
  expires_at: unknown
  committed_at: unknown
}

function rowToStored(row: ChangesetRow): StoredChangeset {
  // W1-B: prepare merges the planned-id ledger into the `summary` JSONB column
  // (no new column — see PlannedEventIds). Split it back out here so the public
  // summary shape stays clean and only the commit path sees the ids.
  const rawSummary = parseJson<ChangesetSummary & { plannedIds?: PlannedEventIds }>(row.summary)
  let summary: ChangesetSummary = rawSummary
  let plannedIds: PlannedEventIds | null = null
  if (rawSummary && typeof rawSummary === 'object' && 'plannedIds' in rawSummary) {
    const { plannedIds: p, ...rest } = rawSummary
    plannedIds = p ?? null
    summary = rest
  }
  return {
    id: row.id,
    projectId: row.project_id,
    createdByUserId: row.created_by_user_id,
    credentialId: row.credential_id,
    autonomyMode: row.autonomy_mode as StoredChangeset['autonomyMode'],
    status: row.status as StoredChangeset['status'],
    commands: parseJson<Command[]>(row.commands),
    preconditions: parseJson<CellPrecondition[]>(row.preconditions),
    summary,
    plannedIds,
    digest: row.digest,
    receipt: row.receipt == null ? null : parseJson<ChangesetReceipt | ReceiptOnlyReceipt | MemoryWriteReceipt>(row.receipt),
    confirmationId: row.confirmation_id,
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    committedAt: row.committed_at == null ? null : toIso(row.committed_at),
  }
}

/** Load one changeset scoped to a project. Returns null when absent. */
export async function loadChangeset(
  db: AquillaDb,
  projectId: string,
  id: string,
): Promise<StoredChangeset | null> {
  const row = await db
    .prepare(
      `SELECT id, project_id, created_by_user_id, credential_id, autonomy_mode,
              status, commands, preconditions, summary, digest, receipt,
              confirmation_id, created_at, expires_at, committed_at
         FROM changesets WHERE id = ? AND project_id = ?`,
    )
    .bind(id, projectId)
    .first<ChangesetRow>()
  return row ? rowToStored(row) : null
}

/** Statuses a changeset row can hold — mirrors the schema CHECK constraint
 *  (`superseded` added by migration 0079, P1 §1). Every status filter validates
 *  against THIS list; nothing else may hard-code the set. */
export const CHANGESET_STATUSES = [
  'staged', 'committing', 'committed', 'discarded', 'stale', 'superseded', 'expired',
] as const

/** Hard cap on the session list endpoint (AQU-926 §3) — also the scan window
 *  the inbox ranks and pages over. */
export const LIST_CHANGESETS_MAX = 50

/** Staged rows surfaced by the default inbox view (P1 §3.3). The rest are
 *  reported as `heldCount`, never as rows — held, not closed, so a later
 *  supersession sweep can still resolve them. An explicit `limit` pages the
 *  full ranked list instead. */
export const SURFACED_CAP = 3

/** Blast radius = every effect the server counted at prepare (P1 §3.3):
 *  translations, source cells + variants, created files, linked media, emitted
 *  events, and settings keys. Ranking is descending, so a plan whose summary
 *  counts nothing sorts last rather than crashing. */
export function blastRadius(summary: ChangesetSummary): number {
  const events = (summary.events ?? []).reduce((n, e) => n + e.count, 0)
  const settingsKeys = Object.keys(summary.settingsChanges ?? {}).length
  return (
    (summary.translationsAdded ?? 0) +
    (summary.translationsModified ?? 0) +
    (summary.sourceCellsAdded ?? 0) +
    (summary.targetVariantsAdded ?? 0) +
    (summary.filesCreated ?? 0) +
    (summary.mediaLinked ?? 0) +
    events +
    settingsKeys
  )
}

/** List a project's changesets, newest-first, over the fixed LIST_CHANGESETS_MAX
 *  scan window (P1 §2.3: the caller is no longer restricted to their own rows —
 *  the route filters by the per-changeset role floor, which needs the stored
 *  commands, so the visibility filter cannot be pushed into SQL). `status`
 *  filters exactly. */
export async function listChangesetsForProject(
  db: AquillaDb,
  projectId: string,
  opts: { status?: string } = {},
): Promise<StoredChangeset[]> {
  const binds: unknown[] = [projectId]
  let statusFilter = ''
  if (opts.status) {
    statusFilter = ' AND status = ?'
    binds.push(opts.status)
  }
  binds.push(LIST_CHANGESETS_MAX)
  const { results } = await db
    .prepare(
      `SELECT id, project_id, created_by_user_id, credential_id, autonomy_mode,
              status, commands, preconditions, summary, digest, receipt,
              confirmation_id, created_at, expires_at, committed_at
         FROM changesets
        WHERE project_id = ?${statusFilter}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .bind(...binds)
    .all<ChangesetRow>()
  return results.map(rowToStored)
}

/** Shape a changeset for API responses — no secret fields exist, but this keeps
 *  the wire shape stable and camelCased. */
export function changesetToResponse(cs: StoredChangeset): Record<string, unknown> {
  return {
    id: cs.id,
    projectId: cs.projectId,
    createdByUserId: cs.createdByUserId,
    credentialId: cs.credentialId,
    autonomyMode: cs.autonomyMode,
    status: cs.status,
    commands: cs.commands,
    preconditions: cs.preconditions,
    summary: cs.summary,
    digest: cs.digest,
    receipt: cs.receipt,
    confirmationId: cs.confirmationId,
    createdAt: cs.createdAt,
    expiresAt: cs.expiresAt,
    committedAt: cs.committedAt,
  }
}
