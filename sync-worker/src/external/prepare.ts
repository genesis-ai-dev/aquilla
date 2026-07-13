// POST /api/v1/external/projects/:projectId/changesets — stage an execution plan.
//
// Validates commands, resolves per-cell preconditions from the live projection,
// computes a deterministic effect summary (no silent skips), content-addresses
// the plan with a digest, and inserts a staged changeset (idempotent on the
// client-supplied UUIDv7 id). Nothing is applied here — ask/act commit does that.

import { errorResponse, toErrorResponse } from './errors'
import { validateCommands, cellKey, type Command } from './commands'
import { resolveCellStates, type CellPrecondition } from './preconditions'
import { computeDigest } from './canonical'
import { uuidv7 } from './uuid'
import { loadChangeset, changesetToResponse } from './store'
import { assertCredentialScope } from './token-bridge'
import type { ChangesetSummary, ChangesetWarning, ExternalEnv } from './types'
import { validateApiCredential } from '../../../db/shared/api-credentials'

/** Staged changesets live for one hour before they expire. */
const CHANGESET_TTL_MS = 60 * 60 * 1000

function bearer(request: Request): string | null {
  const h = request.headers.get('Authorization') ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : null
}

export async function handlePrepare(
  request: Request,
  env: ExternalEnv,
  projectId: string,
): Promise<Response> {
  if (!env.AQUILLA_PG) return errorResponse('job_failed', 'AQUILLA_PG not configured')
  const db = env.AQUILLA_PG

  const cred = await validateApiCredential(db, bearer(request) ?? "")
  if (!cred) return errorResponse('permission_denied', 'invalid or missing API credential')

  try {
    await assertCredentialScope(db, cred, projectId)
  } catch (err) {
    return toErrorResponse(err)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse('validation_failed', 'invalid JSON body')
  }
  const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>

  const validated = validateCommands(raw.commands)
  if (!validated.ok) {
    return errorResponse('validation_failed', 'invalid commands', validated.issues)
  }

  // Effective autonomy: the credential is a ceiling; a request may downgrade
  // act→ask but never upgrade ask→act.
  const requested = raw.autonomyMode
  const autonomyMode: 'ask' | 'act' =
    requested === 'ask' || cred.mode === 'ask' ? 'ask' : 'act'

  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : uuidv7()

  // De-dupe commands by target cell (last write wins); a dropped duplicate is a
  // warning, never a silent drop.
  const warnings: ChangesetWarning[] = []
  const byCell = new Map<string, Command>()
  for (const c of validated.commands) {
    const key = cellKey(c.fileId, c.cellId)
    if (byCell.has(key)) {
      warnings.push({
        code: 'duplicate_command',
        fileId: c.fileId,
        cellId: c.cellId,
        message: 'duplicate command for this cell — later one supersedes the earlier',
      })
    }
    byCell.set(key, c)
  }
  const commands = [...byCell.values()]

  // Resolve live per-cell state and build committable preconditions + summary.
  const states = await resolveCellStates(db, projectId, commands)
  const preconditions: CellPrecondition[] = []
  let translationsAdded = 0
  let translationsModified = 0

  for (const c of commands) {
    const s = states.get(cellKey(c.fileId, c.cellId))
    if (!s || (!s.sourceExists && !s.targetExists)) {
      warnings.push({
        code: 'missing_cell',
        fileId: c.fileId,
        cellId: c.cellId,
        message: 'no source or target cell exists — command skipped',
      })
      continue
    }
    preconditions.push({
      fileId: c.fileId,
      cellId: c.cellId,
      targetHeadEventId: s.targetHeadEventId,
      sourceEventId: s.sourceEventId,
    })
    if (s.targetHeadEventId == null) translationsAdded++
    else translationsModified++
  }

  const summary: ChangesetSummary = { translationsAdded, translationsModified, warnings }
  const digest = await computeDigest(commands, preconditions)
  const expiresAt = new Date(Date.now() + CHANGESET_TTL_MS).toISOString()

  // Idempotent insert on the client-supplied id.
  await db
    .prepare(
      `INSERT INTO changesets (
         id, project_id, created_by_user_id, credential_id, autonomy_mode,
         status, commands, preconditions, summary, digest, expires_at
       ) VALUES (?, ?, ?, ?, ?, 'staged', ?::jsonb, ?::jsonb, ?::jsonb, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    )
    .bind(
      id,
      projectId,
      String(cred.userId),
      cred.credentialId,
      autonomyMode,
      JSON.stringify(commands),
      JSON.stringify(preconditions),
      JSON.stringify(summary),
      digest,
      expiresAt,
    )
    .run()

  // Re-load to return the canonical persisted row (existing one on id-replay).
  const stored = await loadChangeset(db, projectId, id)
  if (!stored) return errorResponse('job_failed', 'changeset insert did not persist')

  const approvalUrl = `${env.BASE_URL ?? ''}/approve/${stored.id}`

  return Response.json({
    changeset: changesetToResponse(stored),
    summary: stored.summary,
    digest: stored.digest,
    approvalUrl,
  })
}
