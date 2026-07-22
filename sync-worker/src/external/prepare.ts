// POST /api/v1/external/projects/:projectId/changesets — stage an execution plan.
//
// Validates commands, resolves per-cell preconditions from the live projection,
// computes a deterministic effect summary (no silent skips), content-addresses
// the plan with a digest, and inserts a staged changeset (idempotent on the
// client-supplied UUIDv7 id). Nothing is applied here — ask/act commit does that.

import { errorResponse, toErrorResponse } from './errors'
import { AUTH_HINT } from './discovery-route'
import {
  validateCommands,
  cellKey,
  requiredRoleForCommand,
  PLAN_IMPORT_MAX_CELLS,
  type Command,
  type CreateProjectCommand,
  type LinkMediaCommand,
  type PlanImportCommand,
  type SetTranslationCommand,
  type UpdateProjectSettingsCommand,
} from './commands'
import { resolveCellStates, type CellPrecondition } from './preconditions'
import { computeDigest } from './canonical'
import { uuidv7 } from './uuid'
import { loadChangeset, changesetToResponse } from './store'
import { assertCredentialScope } from './token-bridge'
import type { ChangesetSummary, ChangesetWarning, ExternalEnv, PlannedEventIds } from './types'
import { validateApiCredential, type ApiCredentialContext } from '../../../db/shared/api-credentials'
import { resolveProjectRoleShared } from '../../../db/shared/project-roles'
import { loadProjectSettings } from '../../../db/shared/projects'
import { ROLE } from '../events/role-policy'

/** Staged changesets live for one hour before they expire. Exported so the MCP
 *  adapter's get_capabilities can publish the real value (never invent limits). */
export const CHANGESET_TTL_MS = 60 * 60 * 1000

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
  if (!cred) return errorResponse('permission_denied', `invalid or missing API credential — ${AUTH_HINT}`)

  // Parse + validate the batch BEFORE the project-existence scope check: a
  // receipt-only CreateProject (W2-A) files its changeset under a
  // not-yet-existing project id and so takes its own path that must skip
  // assertCredentialScope (which would 404 the absent project).
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

  // W2-A CreateProject (receipt-only): sole command in its changeset; scope
  // (unscoped / org-scoped only) and org-role (>= MAINTAINER) are enforced in
  // its own handler — the project doesn't exist yet, so the project-scoped
  // assertCredentialScope + project-role gates below cannot apply.
  const createProject = validated.commands.find(
    (c): c is CreateProjectCommand => c.kind === 'CreateProject',
  )
  if (createProject) {
    if (validated.commands.length !== 1) {
      return errorResponse('validation_failed', 'CreateProject must be the only command in a changeset')
    }
    return prepareCreateProject(db, cred, projectId, id, autonomyMode, createProject, env)
  }

  // Every remaining command operates on an EXISTING project — enforce the
  // credential's scope ceiling first.
  try {
    await assertCredentialScope(db, cred, projectId)
  } catch (err) {
    return toErrorResponse(err)
  }

  // W2-A UpdateProjectSettings (receipt-only): sole command; project role
  // (>= MAINTAINER) and the settings version pin are enforced in its handler.
  const updateSettings = validated.commands.find(
    (c): c is UpdateProjectSettingsCommand => c.kind === 'UpdateProjectSettings',
  )
  if (updateSettings) {
    if (validated.commands.length !== 1) {
      return errorResponse('validation_failed', 'UpdateProjectSettings must be the only command in a changeset')
    }
    return prepareUpdateProjectSettings(db, cred, projectId, id, autonomyMode, updateSettings, env)
  }

  // Live role/membership gate (§2 — resolve the caller's CURRENT role on every
  // call, never a role baked into the credential). Scope alone (checked above)
  // does not imply membership: a non-member with a project-scoped credential
  // would otherwise receive the server-computed effect summary (cell existence,
  // added/modified counts). Require the role FLOOR of the command kind being
  // staged — the same floor its commit hits at the /events perimeter, so a plan
  // the caller could never commit is denied here rather than leaked.
  const requiredRole = Math.max(...validated.commands.map(requiredRoleForCommand))
  const resolvedRole = await resolveProjectRoleShared(db, { id: cred.userId }, projectId)
  if (!resolvedRole || resolvedRole.level < requiredRole) {
    return errorResponse('permission_denied', 'insufficient project role to stage this changeset')
  }

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

  // LinkMedia takes its own prepare path (per-cell audio attach, not a
  // per-cell translation batch). For v1 a LinkMedia changeset holds only
  // LinkMedia commands — mixing with SetTranslation is rejected.
  const linkMedia = validated.commands.filter(
    (c): c is LinkMediaCommand => c.kind === 'LinkMedia',
  )
  if (linkMedia.length > 0) {
    if (linkMedia.length !== validated.commands.length) {
      return errorResponse(
        'validation_failed',
        'LinkMedia cannot be mixed with other command kinds in one changeset',
      )
    }
    return prepareLinkMedia(db, cred, projectId, id, autonomyMode, linkMedia, env)
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

  // W1-B (§4): mint the compiled target.cell.commit event id for every resolved
  // precondition NOW and store it in the plan, so a crash-and-retry commit
  // re-posts the same ids (the /events layer dedupes) rather than minting fresh
  // ones. Digest is computed above over commands + preconditions only, so these
  // ids never perturb it (two prepares of the same plan still match).
  const plannedIds: PlannedEventIds = {
    setTranslation: preconditions.map((p) => ({
      fileId: p.fileId,
      cellId: p.cellId,
      eventId: uuidv7(),
    })),
  }

  // Idempotent insert on the client-supplied id. The planned-id ledger rides in
  // the summary JSONB column (no new column — split back out on load).
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
      JSON.stringify({ ...summary, plannedIds }),
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

  // W1-B (§4): mint the file id, its file.create event id, and per-cell
  // {cellId, eventId} NOW (cellId minted here when the plan cell omits its own).
  // Stored in the plan so a crash-and-retry commit re-posts the SAME file +
  // event ids — the /events idempotency layer dedupes them — instead of a fresh
  // mint creating a duplicate file. Minted separately from `cmd` so the digest
  // (over commands + preconditions) is unaffected and stays stable per plan.
  const plannedIds: PlannedEventIds = {
    planImport: {
      fileId: uuidv7(),
      fileEventId: uuidv7(),
      cells: cmd.cells.map((cell) => ({
        cellId: cell.id ?? uuidv7(),
        eventId: uuidv7(),
      })),
    },
  }

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
      JSON.stringify({ ...summary, plannedIds }),
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

// ── W2-A: receipt-only project-lifecycle commands (spec §2, D8) ───────────────

/** Live org-member role level for (orgId, userId), or null when not a member.
 *  Mirrors auth-worker getOrgMemberRole — the receipt-only CreateProject path
 *  resolves org membership directly because no project row exists yet to hang a
 *  project role off. Platform-admin elevation is intentionally NOT applied: the
 *  external API confers no cross-tenant project-creation authority. */
async function resolveOrgRoleLevel(
  db: AquillaDb,
  orgId: number,
  userId: string,
): Promise<number | null> {
  const row = await db
    .prepare(`SELECT role_level FROM org_members WHERE org_id = ? AND user_id = ?`)
    .bind(orgId, userId)
    .first<{ role_level: number }>()
  return row?.role_level ?? null
}

/** Stage a receipt-only project-lifecycle changeset (CreateProject /
 *  UpdateProjectSettings): no per-cell preconditions, a caller-built effect
 *  summary (the command's renderable fields, so /approve/:id shows what's being
 *  applied rather than "No changes summarized."), and a plan carrying only its
 *  pinned ids (definitive project id / settings version). Mirrors
 *  preparePlanImport's insert + response. */
async function stageReceiptOnlyChangeset(
  db: AquillaDb,
  cred: ApiCredentialContext,
  changesetProjectId: string,
  id: string,
  autonomyMode: 'ask' | 'act',
  cmd: Command,
  plannedIds: PlannedEventIds,
  summary: ChangesetSummary,
  env: ExternalEnv,
): Promise<Response> {
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
      changesetProjectId,
      String(cred.userId),
      cred.credentialId,
      autonomyMode,
      JSON.stringify(commands),
      JSON.stringify(preconditions),
      JSON.stringify({ ...summary, plannedIds }),
      digest,
      expiresAt,
    )
    .run()

  const stored = await loadChangeset(db, changesetProjectId, id)
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
 * Prepare a LinkMedia changeset (Agent API v1.1 §3): for each attach command,
 * verify the target cell exists in the live projection and the referenced
 * artifact exists, is kind `audio`, and belongs to this project, then stage the
 * plan. Compiles at commit to cell.audio.attach + cell.audio.select events;
 * the attach/select event ids are minted here (§4 prepare-time ids) so a
 * crash-and-retry re-posts identical ids. Preconditions are empty — the
 * artifact + cell existence are re-checked directly at commit (plan_stale on
 * disappearance), so no per-cell head is pinned (attaching audio does not
 * conflict with a concurrent text edit on the same cell).
 */
async function prepareLinkMedia(
  db: AquillaDb,
  cred: ApiCredentialContext,
  projectId: string,
  id: string,
  autonomyMode: 'ask' | 'act',
  cmds: LinkMediaCommand[],
  env: ExternalEnv,
): Promise<Response> {
  // Resolve live state for every target cell in one query.
  const cellStates = await resolveCellStates(db, projectId, cmds)
  const plannedLinkMedia: NonNullable<PlannedEventIds['linkMedia']> = []

  for (const cmd of cmds) {
    const s = cellStates.get(cellKey(cmd.fileId, cmd.cellId))
    if (!s || (!s.sourceExists && !s.targetExists)) {
      return errorResponse(
        'validation_failed',
        `cell ${cmd.cellId} in file ${cmd.fileId} does not exist`,
      )
    }
    const artifact = await db
      .prepare(`SELECT id, kind FROM artifacts WHERE id::text = ? AND project_id = ?`)
      .bind(cmd.artifactId, projectId)
      .first<{ id: string; kind: string }>()
    if (!artifact) {
      return errorResponse('validation_failed', `artifact ${cmd.artifactId} not found in project`)
    }
    if (artifact.kind !== 'audio') {
      return errorResponse('validation_failed', `artifact ${cmd.artifactId} is not an audio artifact`)
    }
    plannedLinkMedia.push({
      fileId: cmd.fileId,
      cellId: cmd.cellId,
      artifactId: cmd.artifactId,
      attachEventId: uuidv7(),
      selectEventId: uuidv7(),
    })
  }

  const summary: ChangesetSummary = { mediaLinked: cmds.length, warnings: [] }
  const commands: Command[] = [...cmds]
  const preconditions: CellPrecondition[] = []
  const digest = await computeDigest(commands, preconditions)
  const expiresAt = new Date(Date.now() + CHANGESET_TTL_MS).toISOString()
  const plannedIds: PlannedEventIds = { linkMedia: plannedLinkMedia }

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
      JSON.stringify({ ...summary, plannedIds }),
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

/**
 * Prepare a CreateProject changeset (spec §2). Enforces the scope rule
 * (unscoped / org-scoped-to-target only; project-scoped → scope_denied), the
 * org-role floor (>= MAINTAINER in the target org), and the id-not-taken
 * precondition. The definitive project id is pinned in the plan so a
 * crash-retry re-applies the SAME id (prepare-time-ids doctrine).
 */
async function prepareCreateProject(
  db: AquillaDb,
  cred: ApiCredentialContext,
  urlProjectId: string,
  id: string,
  autonomyMode: 'ask' | 'act',
  cmd: CreateProjectCommand,
  env: ExternalEnv,
): Promise<Response> {
  // Scope: a project-scoped credential can NEVER create a project. (Act tokens
  // are project-scoped at mint, so CreateProject is ask-mode-only by design.)
  if (cred.projectId != null) {
    return errorResponse('scope_denied', 'a project-scoped credential cannot create projects')
  }

  // Resolve the target org id.
  let orgId: number | null = null
  if (cmd.orgId != null) {
    orgId = typeof cmd.orgId === 'number' ? cmd.orgId : Number(cmd.orgId)
    if (!Number.isInteger(orgId)) {
      return errorResponse('validation_failed', 'CreateProject.orgId must be an integer org id')
    }
  }

  // An org-scoped credential may only create into its own org.
  const targetOrgStr = orgId == null ? null : String(orgId)
  if (cred.orgId != null && cred.orgId !== targetOrgStr) {
    return errorResponse('scope_denied', 'credential org scope does not match the target org')
  }

  // Org-role gate: >= MAINTAINER in the target org (org-level — no project row
  // exists yet to resolve a project role against). A personal (org-less) project
  // has no org to gate on; only an unscoped credential reaches that path and the
  // creator becomes owner via the membership row written at commit.
  if (orgId != null) {
    const level = await resolveOrgRoleLevel(db, orgId, cred.userId)
    if (level == null || level < ROLE.MAINTAINER) {
      return errorResponse('permission_denied', 'org role >= maintainer required to create a project')
    }
  }

  // Definitive project id — explicit, else the changeset URL project id.
  const definitiveProjectId = cmd.projectId ?? urlProjectId
  const existing = await db
    .prepare(`SELECT id FROM projects WHERE id = ?`)
    .bind(definitiveProjectId)
    .first<{ id: string }>()
  if (existing) {
    return errorResponse('validation_failed', `project ${definitiveProjectId} already exists`)
  }

  const plannedIds: PlannedEventIds = {
    createProject: { projectId: definitiveProjectId, orgId },
  }

  // CreateProject is human-approved by design (spec §2, §3 "ask-mode only, by
  // construction"): FORCE the staged changeset to ask-mode regardless of the
  // credential's or request's mode, so every agent-initiated project creation
  // passes through /approve/:id. Org-scoped act tokens (which the mint endpoint
  // still permits) keep act for their OTHER commands — only CreateProject is
  // pinned to ask here. `autonomyMode` is intentionally ignored on this path.
  void autonomyMode

  // Effect summary the /approve page renders (blind-approval fix): the command
  // kind plus the definitive facts a human needs to authorize a project create.
  const summary: ChangesetSummary = {
    command: 'CreateProject',
    projectName: cmd.name,
    newProjectId: definitiveProjectId,
    targetOrg: orgId == null ? 'personal' : String(orgId),
    warnings: [],
  }
  return stageReceiptOnlyChangeset(db, cred, urlProjectId, id, 'ask', cmd, plannedIds, summary, env)
}

/**
 * Prepare an UpdateProjectSettings changeset (spec §2). The command project must
 * be the scoped changeset project (else the scope check would guard a different
 * project than the one written). Enforces the project-role floor (>= MAINTAINER)
 * and pins the settings version (`ifMatchVersion` must equal the live version,
 * else plan_stale) so commit can re-check the same guard.
 */
async function prepareUpdateProjectSettings(
  db: AquillaDb,
  cred: ApiCredentialContext,
  urlProjectId: string,
  id: string,
  autonomyMode: 'ask' | 'act',
  cmd: UpdateProjectSettingsCommand,
  env: ExternalEnv,
): Promise<Response> {
  if (cmd.projectId !== urlProjectId) {
    return errorResponse(
      'validation_failed',
      'UpdateProjectSettings.projectId must match the changeset project',
    )
  }

  const role = await resolveProjectRoleShared(db, { id: cred.userId }, urlProjectId)
  if (!role || role.level < ROLE.MAINTAINER) {
    return errorResponse('permission_denied', 'project role >= maintainer required to update settings')
  }

  const current = await loadProjectSettings(db, urlProjectId)
  if (current.version !== cmd.ifMatchVersion) {
    return errorResponse('plan_stale', 'settings version changed since prepare', {
      expected: cmd.ifMatchVersion,
      current: current.version,
    })
  }

  const plannedIds: PlannedEventIds = {
    updateProjectSettings: { version: cmd.ifMatchVersion },
  }

  // Effect summary the /approve page renders (blind-approval fix): the command
  // kind, project id, pinned version, and a compact per-key preview of the new
  // settings values (truncated — never dump a huge blob into the approval box).
  const settingsChanges: Record<string, string> = {}
  for (const key of Object.keys(cmd.settings)) {
    settingsChanges[key] = previewSettingValue(cmd.settings[key])
  }
  const summary: ChangesetSummary = {
    command: 'UpdateProjectSettings',
    projectId: urlProjectId,
    ifMatchVersion: cmd.ifMatchVersion,
    settingsChanges,
    warnings: [],
  }
  return stageReceiptOnlyChangeset(db, cred, urlProjectId, id, autonomyMode, cmd, plannedIds, summary, env)
}

/** Compact, truncated preview of a single settings value for the approval page.
 *  Objects/arrays are JSON-stringified; everything is capped so a large nested
 *  blob renders as a short, human-scannable snippet rather than a wall of text. */
const SETTING_PREVIEW_MAX = 80
function previewSettingValue(value: unknown): string {
  let s: string
  if (value === null) s = 'null'
  else if (value === undefined) s = 'undefined'
  else if (typeof value === 'object') s = JSON.stringify(value)
  else s = String(value)
  return s.length > SETTING_PREVIEW_MAX ? `${s.slice(0, SETTING_PREVIEW_MAX - 1)}…` : s
}
