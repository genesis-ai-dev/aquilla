// POST /api/v1/external/projects/:projectId/changesets — stage an execution plan.
//
// Validates commands, resolves per-cell preconditions from the live projection,
// computes a deterministic effect summary (no silent skips), content-addresses
// the plan with a digest, and inserts a staged changeset (idempotent on the
// client-supplied UUIDv7 id). Nothing is applied here — ask/act commit does that.

import { errorResponse, toErrorResponse } from './errors'
import {
  validateCommands,
  cellKey,
  PLAN_IMPORT_MAX_CELLS,
  type Command,
  type PlanImportCommand,
  type SetTranslationCommand,
} from './commands'
import { resolveCellStates, type CellPrecondition } from './preconditions'
import { computeDigest } from './canonical'
import { uuidv7 } from './uuid'
import { loadChangeset, changesetToResponse } from './store'
import { assertCredentialScope } from './token-bridge'
import type { ChangesetSummary, ChangesetWarning, ExternalEnv } from './types'
import { validateApiCredential, type ApiCredentialContext } from '../../../db/shared/api-credentials'

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

  // PlanImport is a whole-file operation, not a per-cell batch — it takes its
  // own prepare path (no cell preconditions; a duplicate-name precondition). A
  // PlanImport must be the sole command in its changeset.
  const planImports = validated.commands.filter(
    (c): c is PlanImportCommand => c.kind === 'PlanImport',
  )
  if (planImports.length > 0) {
    if (validated.commands.length !== 1) {
      return errorResponse(
        'validation_failed',
        'PlanImport must be the only command in a changeset',
      )
    }
    return preparePlanImport(db, cred, projectId, id, autonomyMode, planImports[0], env)
  }

  // Past the PlanImport branch every remaining command is a SetTranslation.
  const setCommands = validated.commands.filter(
    (c): c is SetTranslationCommand => c.kind === 'SetTranslation',
  )

  // De-dupe commands by target cell (last write wins); a dropped duplicate is a
  // warning, never a silent drop.
  const warnings: ChangesetWarning[] = []
  const byCell = new Map<string, SetTranslationCommand>()
  for (const c of setCommands) {
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

/**
 * Prepare a PlanImport changeset: validate the plan, compute the server-side
 * effect summary (files_created / source_cells_added / artifact_linked), and
 * stage it. Preconditions are empty — a brand-new file has no per-cell live
 * state to pin; the only precondition is a soft duplicate-name warning.
 */
async function preparePlanImport(
  db: AquillaDb,
  cred: ApiCredentialContext,
  projectId: string,
  id: string,
  autonomyMode: 'ask' | 'act',
  cmd: PlanImportCommand,
  env: ExternalEnv,
): Promise<Response> {
  if (cmd.cells.length === 0) {
    return errorResponse('validation_failed', 'PlanImport.cells must be non-empty')
  }
  if (cmd.cells.length > PLAN_IMPORT_MAX_CELLS) {
    return errorResponse('validation_failed', 'PlanImport exceeds maximum cells per changeset', {
      cells: cmd.cells.length,
      maxCells: PLAN_IMPORT_MAX_CELLS,
    })
  }

  // A referenced artifact must exist in this project.
  if (cmd.artifactId) {
    const artifact = await db
      .prepare(`SELECT id FROM artifacts WHERE id::text = ? AND project_id = ?`)
      .bind(cmd.artifactId, projectId)
      .first<{ id: string }>()
    if (!artifact) {
      return errorResponse('validation_failed', `artifact ${cmd.artifactId} not found in project`)
    }
  }

  // Soft precondition: a same-named active file already exists → warn, don't
  // block (§3 "no silent truncation" — the collision is surfaced in the summary).
  const warnings: ChangesetWarning[] = []
  const existing = await db
    .prepare(
      `SELECT id FROM files WHERE project_id = ? AND name = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .bind(projectId, cmd.fileName)
    .first<{ id: string }>()
  if (existing) {
    warnings.push({
      code: 'duplicate_file',
      fileId: existing.id,
      cellId: '',
      message: `a file named "${cmd.fileName}" already exists — a second file with the same name will be created`,
    })
  }

  const summary: ChangesetSummary = {
    filesCreated: 1,
    sourceCellsAdded: cmd.cells.length,
    ...(cmd.artifactId ? { artifactLinked: cmd.artifactId } : {}),
    warnings,
  }
  const commands: Command[] = [cmd]
  const preconditions: CellPrecondition[] = []
  const digest = await computeDigest(commands, preconditions)
  const expiresAt = new Date(Date.now() + CHANGESET_TTL_MS).toISOString()

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
