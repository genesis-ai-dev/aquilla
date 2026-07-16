// Changeset row persistence helpers.

import type { Command } from './commands'
import type { CellPrecondition } from './preconditions'
import type {
  ChangesetReceipt,
  ChangesetSummary,
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
  return {
    id: row.id,
    projectId: row.project_id,
    createdByUserId: row.created_by_user_id,
    credentialId: row.credential_id,
    autonomyMode: row.autonomy_mode as StoredChangeset['autonomyMode'],
    status: row.status as StoredChangeset['status'],
    commands: parseJson<Command[]>(row.commands),
    preconditions: parseJson<CellPrecondition[]>(row.preconditions),
    summary: parseJson<ChangesetSummary>(row.summary),
    digest: row.digest,
    receipt: row.receipt == null ? null : parseJson<ChangesetReceipt>(row.receipt),
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
