// POST /api/v1/external/projects/:projectId/changesets — stage an execution plan.
//
// Validates commands, resolves per-cell preconditions from the live projection,
// computes a deterministic effect summary (no silent skips), content-addresses
// the plan with a digest, and inserts a staged changeset (idempotent on the
// client-supplied UUIDv7 id). Nothing is applied here — ask/act commit does that.

import { ExternalError, errorResponse, toErrorResponse } from './errors'
import { AUTH_HINT } from './discovery-route'
import {
  validateCommands,
  isStructureCommandKind,
  laneCellKey,
  requiredRoleForCommand,
  PLAN_IMPORT_MAX_CELLS,
  type Command,
  type CreateOrgCommand,
  type StructureCommand,
  type CreateProjectCommand,
  type DraftCellsCommand,
  type EmitEventsCommand,
  type LinkMediaCommand,
  type PatchSettingsCommand,
  type PlanImportCommand,
  type ProjectLifecycleCommand,
  type RenameFileCommand,
  type SetBriefCommand,
  type SetTranslationCommand,
  type UpdateProjectSettingsCommand,
} from './commands'
import { isOrgMemberCommand, type OrgMemberCommand } from './commands-org-members'
import { prepareOrgMember } from './org-members-engine'
import { changedPolicyKeys, preparePatchSettings, previewSettingValue } from './commands-patch-settings'
import { assertWithinBatchCap, requestDrafts } from './commands-draft-cells'
import { completionBatchSizeFromSettings } from '../../../db/shared/completion-batch'
import {
  isMembershipCommand,
  prepareMembership,
  type MembershipCommand,
} from './commands-membership'
import { isProjectLifecycleCommand, prepareProjectLifecycle } from './commands-project-lifecycle'
import { renameFileToEmitEvents } from './commands-rename-file'
import { prepareSetBrief } from './commands-set-brief'
import { isMemoryCommand, prepareMemoryCommand } from './commands-memory'
import { prepareEmitEvents } from './emit-events-engine'
import { prepareCellFields } from './cell-fields-engine'
import { isCellFieldCommand, CELL_FIELDS_MAX_COMMANDS, type CellFieldCommand } from './commands-cell-fields'
import { prepareStructure } from './structure-engine'
import { resolveCellStates, type CellPrecondition } from './preconditions'
import { uuidv7 } from './uuid'
import { stageAndRespond } from './stage'
import { assertCredentialScope } from './token-bridge'
import type { ChangesetSummary, ChangesetWarning, ExternalEnv, PlannedEventIds } from './types'
import { validateApiCredential, type ApiCredentialContext } from '../../../db/shared/api-credentials'
import { resolveProjectRoleShared } from '../../../db/shared/project-roles'
import { loadProjectSettings } from '../../../db/shared/projects'
import { countRecentRateLimitEvents, recordRateLimitEvent } from '../../../db/shared/rate-limit'
import { ROLE } from '../events/role-policy'

// Staging primitives moved to stage.ts (AQU-926) so the new command modules
// share them without an import cycle; re-exported here for existing importers
// (mcp-handlers, changesets-route, tests).
export { approvalUrlFor, CHANGESET_ASK_TTL_MS, CHANGESET_TTL_MS } from './stage'

function bearer(request: Request): string | null {
  const h = request.headers.get('Authorization') ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : null
}

// [Pen test] API security & data exposure (2026-08-20): the external Agent
// API's only throttle was on /search (2026-07-30 pen test) — every mutating
// route, including this one, was unlimited. A leaked or malicious PAT could
// stage unbounded changesets. Wide enough that a real agent loop staging a
// plan every few seconds never trips it.
const PREPARE_MAX_PER_CREDENTIAL = 300

/**
 * CreateOrg throttle (AQU-1221): at most 5 org-creation changesets staged per
 * credential per 15-minute window (the shared sliding window in
 * db/shared/rate-limit.ts). Org creation is the one agent command that mints a
 * whole new TENANT, so a runaway loop is not merely noisy — it litters the
 * user's org switcher and the platform-admin views with junk tenants that a
 * human then has to clean up. Deliberately far tighter than the generic
 * PREPARE_MAX_PER_CREDENTIAL: a legitimate partner-onboarding agent creates one
 * org and moves on, so five in a quarter-hour is already generous.
 *
 * Counted at PREPARE. Every CreateOrg is forced to ask-mode, so a human
 * approval already gates each commit; throttling the staging step is what stops
 * an agent from flooding that human's approval queue in the first place.
 */
export const CREATE_ORG_MAX_PER_CREDENTIAL = 5

/** PAT-authenticated entrypoint (REST + the MCP adapter's synthetic request):
 *  resolves the credential, parses the body, and hands off to the shared core
 *  the session-token routes also use. */
export async function handlePrepare(
  request: Request,
  env: ExternalEnv,
  projectId: string,
): Promise<Response> {
  if (!env.AQUILLA_PG) return errorResponse('job_failed', 'AQUILLA_PG not configured')
  const db = env.AQUILLA_PG

  const cred = await validateApiCredential(db, bearer(request) ?? "")
  if (!cred) return errorResponse('permission_denied', `invalid or missing API credential — ${AUTH_HINT}`)

  const identifier = `credential:${cred.credentialId}`
  const recent = await countRecentRateLimitEvents(db, 'external_prepare', identifier)
  if (recent >= PREPARE_MAX_PER_CREDENTIAL) {
    return errorResponse('rate_limited', 'changeset staging rate limit exceeded, slow down')
  }
  await recordRateLimitEvent(db, 'external_prepare', identifier)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse('validation_failed', 'invalid JSON body')
  }
  const raw = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>

  return prepareChangesetCore(db, env, cred, projectId, raw)
}

/**
 * Post-auth prepare core, shared by the PAT entrypoint above and the
 * session-token routes (session-routes.ts). `cred` is either a validated API
 * credential or the session principal ({ credentialId: 'session', mode: 'ask',
 * orgId/projectId: null }) — the session's 'ask' mode makes the effective-
 * autonomy formula below force ask, and its null scopes make
 * assertCredentialScope a pure project-existence check.
 */
export async function prepareChangesetCore(
  db: AquillaDb,
  env: ExternalEnv,
  cred: ApiCredentialContext,
  projectId: string,
  raw: Record<string, unknown>,
): Promise<Response> {
  // Validate the batch BEFORE the project-existence scope check: a
  // receipt-only CreateProject (W2-A) files its changeset under a
  // not-yet-existing project id and so takes its own path that must skip
  // assertCredentialScope (which would 404 the absent project).
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

  // AQU-1235 org membership (receipt-only): also ORG-level authority, so it
  // likewise skips the project-scope / project-role gates below — the target is
  // an org roster, not this project. Sole command, forced ask-mode.
  const orgMember = validated.commands.find((c): c is OrgMemberCommand => isOrgMemberCommand(c))
  if (orgMember) {
    if (validated.commands.length !== 1) {
      return errorResponse(
        'validation_failed',
        `${orgMember.kind} must be the only command in a changeset`,
      )
    }
    return prepareOrgMember(db, cred, projectId, id, orgMember, env)
  }

  // CreateOrg (AQU-1221, receipt-only): sole command in its changeset. Like
  // CreateProject it must skip assertCredentialScope — it creates a tenant, so
  // neither the changeset's URL project nor any org exists to scope against.
  const createOrg = validated.commands.find(
    (c): c is CreateOrgCommand => c.kind === 'CreateOrg',
  )
  if (createOrg) {
    if (validated.commands.length !== 1) {
      return errorResponse('validation_failed', 'CreateOrg must be the only command in a changeset')
    }
    return prepareCreateOrg(db, cred, projectId, id, autonomyMode, createOrg, env)
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

  // PatchSettings (AQU-926 §2): sole command; per-key floors (incl. the org
  // termbase floor), the policy-key denial, and the version pin live in its
  // module — like UpdateProjectSettings it skips the generic role gate below.
  const patchSettings = validated.commands.find(
    (c): c is PatchSettingsCommand => c.kind === 'PatchSettings',
  )
  if (patchSettings) {
    if (validated.commands.length !== 1) {
      return errorResponse('validation_failed', 'PatchSettings must be the only command in a changeset')
    }
    return preparePatchSettings(db, cred, projectId, id, autonomyMode, patchSettings, env)
  }

  // AQU-1185 membership (InviteMember / SetRole / RemoveMember): receipt-only,
  // its own module owns the MAINTAINER floor plus the grant and target caps, and
  // it FORCES ask-mode — so like the settings commands it skips the generic role
  // gate below. Membership kinds may batch with each other (one approval covers
  // one roster change) but never with another kind: the human on /approve must
  // be reading a membership decision, not a membership decision buried in an
  // import.
  const membership = validated.commands.filter((c): c is MembershipCommand =>
    isMembershipCommand(c),
  )
  if (membership.length > 0) {
    if (membership.length !== validated.commands.length) {
      return errorResponse(
        'validation_failed',
        'membership commands cannot be mixed with other command kinds in one changeset',
      )
    }
    return prepareMembership(db, cred, projectId, id, membership, env)
  }

  // Project lifecycle (AQU-1182): RenameProject / ArchiveProject /
  // UnarchiveProject — receipt-only row writes, sole command per changeset. They
  // MUST precede the generic role gate below: that gate resolves the role with
  // resolveProjectRoleShared, which denies every archived project, so an
  // UnarchiveProject would be permission_denied by construction. Their module
  // resolves the archived-tolerant role instead (the same resolver auth-worker's
  // own archive endpoints use) and enforces the per-kind UI floor itself.
  const lifecycle = validated.commands.find(
    (c): c is ProjectLifecycleCommand => isProjectLifecycleCommand(c),
  )
  if (lifecycle) {
    if (validated.commands.length !== 1) {
      return errorResponse('validation_failed', `${lifecycle.kind} must be the only command in a changeset`)
    }
    return prepareProjectLifecycle(db, cred, projectId, id, autonomyMode, lifecycle, env)
  }

  // SetBrief (AQU-1227): sole command — it writes the `translationBrief` key of
  // the same versioned settings blob, so sharing a changeset with another
  // settings write would double-bump the version. Its role floor and version
  // pin live in its module, like the two above.
  const setBrief = validated.commands.find((c): c is SetBriefCommand => c.kind === 'SetBrief')
  if (setBrief) {
    if (validated.commands.length !== 1) {
      return errorResponse('validation_failed', 'SetBrief must be the only command in a changeset')
    }
    return prepareSetBrief(db, cred, projectId, id, autonomyMode, setBrief, env)
  }

  // AQU-1228 Living Memory writes: sole command; receipt-only like
  // PatchSettings, with its own floors (propose vs. review tier) and the
  // human-edited guard, so it also skips the generic role gate below.
  const memoryCommand = validated.commands.find(isMemoryCommand)
  if (memoryCommand) {
    if (validated.commands.length !== 1) {
      return errorResponse(
        'validation_failed',
        `${memoryCommand.kind} must be the only command in a changeset`,
      )
    }
    return prepareMemoryCommand(db, cred, projectId, id, autonomyMode, memoryCommand, env)
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

  // EmitEvents (AQU-926 §2): sole command (one command already batches many
  // events). The static max-floor gate just ran; its engine adds the dynamic
  // maintainer bumps + live existence/pin resolution.
  const emitEvents = validated.commands.find(
    (c): c is EmitEventsCommand => c.kind === 'EmitEvents',
  )
  if (emitEvents) {
    if (validated.commands.length !== 1) {
      return errorResponse('validation_failed', 'EmitEvents must be the only command in a changeset')
    }
    return prepareEmitEvents(db, cred, projectId, id, autonomyMode, emitEvents, env, resolvedRole.level)
  }

  // DraftCells (AQU-1186): a prepare-time expansion — run the project's copilot
  // NOW, then fall through the ordinary SetTranslation path with the generated
  // text. Sole command in its changeset (one command already batches many
  // cells, and the cap is per-changeset).
  const draftCells = validated.commands.find(
    (c): c is DraftCellsCommand => c.kind === 'DraftCells',
  )
  let pending: Command[] = validated.commands
  if (draftCells) {
    if (validated.commands.length !== 1) {
      return errorResponse('validation_failed', 'DraftCells must be the only command in a changeset')
    }
    try {
      pending = await expandDraftCells(db, env, cred, projectId, draftCells)
    } catch (err) {
      return toErrorResponse(err)
    }
  }

  // AQU-1183 cell-field family (SetSource / SetTranscription / SetTiming /
  // SetTrackOverride): its own prepare path. These write EXISTING cell/file
  // fields — two of them compile to the chain-mutating `source.cell.commit`,
  // so the batch is normalized to one source event per cell (a mixed batch
  // with SetTranslation would have two writers on one chain slot). The static
  // max-floor gate just ran; the engine adds the live pins, existence checks
  // and the two dynamic gates (timing lock, allowTrackEditing).
  const cellFields: CellFieldCommand[] = validated.commands.filter(isCellFieldCommand)
  if (cellFields.length > 0) {
    if (cellFields.length !== validated.commands.length) {
      return errorResponse(
        'validation_failed',
        'cell-field commands (SetSource, SetTranscription, SetTiming, SetTrackOverride) cannot be mixed with other command kinds in one changeset',
      )
    }
    if (cellFields.length > CELL_FIELDS_MAX_COMMANDS) {
      return errorResponse(
        'validation_failed',
        `too many cell-field commands in one changeset (max ${CELL_FIELDS_MAX_COMMANDS})`,
      )
    }
    return prepareCellFields(db, cred, projectId, id, autonomyMode, cellFields, env, resolvedRole.level)
  }

  // RenameFile (AQU-1182): sugar over a single `file.rename` event. Desugar into
  // the equivalent EmitEvents command and hand it to that engine — one compile
  // path, one set of existence checks, one prepare-time id ledger. The role gate
  // above already enforced file.rename's floor (requiredRoleForCommand returns
  // it verbatim), so the plan an agent could not commit is refused here too.
  const renameFiles = validated.commands.filter(
    (c): c is RenameFileCommand => c.kind === 'RenameFile',
  )
  if (renameFiles.length > 0) {
    if (renameFiles.length !== validated.commands.length) {
      return errorResponse(
        'validation_failed',
        'RenameFile cannot be mixed with other command kinds in one changeset',
      )
    }
    return prepareEmitEvents(
      db,
      cred,
      projectId,
      id,
      autonomyMode,
      renameFileToEmitEvents(renameFiles),
      env,
      resolvedRole.level,
    )
  }

  // Cell-structure commands (AQU-1234): sole command per changeset. A
  // structural edit is one indivisible rewrite of a file's anchor chain — two
  // of them in one plan could name each other's cells and would have to be
  // ordered and re-pinned against a chain that the first one moved. One per
  // changeset keeps the plan reviewable and the pins honest.
  const structure = validated.commands.find(
    (c): c is StructureCommand => isStructureCommandKind(c.kind),
  )
  if (structure) {
    if (validated.commands.length !== 1) {
      return errorResponse(
        'validation_failed',
        `${structure.kind} must be the only command in a changeset`,
      )
    }
    return prepareStructure(db, cred, projectId, id, autonomyMode, structure, env)
  }

  // PlanImport is a whole-file operation, not a per-cell batch — it takes its
  // own prepare path (no cell preconditions; a duplicate-name precondition). A
  // PlanImport must be the sole command in its changeset.
  const planImports = pending.filter(
    (c): c is PlanImportCommand => c.kind === 'PlanImport',
  )
  if (planImports.length > 0) {
    if (pending.length !== 1) {
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
  const linkMedia = pending.filter(
    (c): c is LinkMediaCommand => c.kind === 'LinkMedia',
  )
  if (linkMedia.length > 0) {
    if (linkMedia.length !== pending.length) {
      return errorResponse(
        'validation_failed',
        'LinkMedia cannot be mixed with other command kinds in one changeset',
      )
    }
    return prepareLinkMedia(db, cred, projectId, id, autonomyMode, linkMedia, env)
  }

  // Past the PlanImport branch every remaining command is a SetTranslation —
  // either the caller's own, or the ones DraftCells just materialized.
  const setCommands = pending.filter(
    (c): c is SetTranslationCommand => c.kind === 'SetTranslation',
  )

  // AQU-538 lanes: a SetTranslation naming a lane must target a lane the
  // workspace can select — same rule (and same teaching message) as PlanImport
  // variants. Settings are only loaded when a lane is actually named, so the
  // lane-less common case costs no extra query.
  if (setCommands.some((c) => c.laneId)) {
    const projectSettings = await loadProjectSettings(db, projectId)
    const registeredLanes = new Set(
      Array.isArray(projectSettings.settings.targetLanes)
        ? projectSettings.settings.targetLanes.filter((lane): lane is string => typeof lane === 'string')
        : [],
    )
    for (const [index, c] of setCommands.entries()) {
      if (c.laneId && !registeredLanes.has(c.laneId)) {
        return errorResponse(
          'validation_failed',
          `commands[${index}] targets unregistered lane "${c.laneId}"; register it in the project's settings.targetLanes with UpdateProjectSettings first`,
          { registeredLanes: [...registeredLanes] },
        )
      }
    }
  }

  // De-dupe commands by target (cell, lane) — the same cell in two lanes is two
  // independent slots (last write wins per lane); a dropped duplicate is a
  // warning, never a silent drop.
  const warnings: ChangesetWarning[] = []
  const byCell = new Map<string, SetTranslationCommand>()
  for (const c of setCommands) {
    const key = laneCellKey(c.fileId, c.cellId, c.laneId)
    if (byCell.has(key)) {
      warnings.push({
        code: 'duplicate_command',
        fileId: c.fileId,
        cellId: c.cellId,
        message: 'duplicate command for this cell and lane — later one supersedes the earlier',
      })
    }
    byCell.set(key, c)
  }
  const commands = [...byCell.values()]

  // Resolve live per-(cell, lane) state and build committable preconditions +
  // summary.
  const states = await resolveCellStates(db, projectId, commands)
  const preconditions: CellPrecondition[] = []
  let translationsAdded = 0
  let translationsModified = 0

  for (const c of commands) {
    const s = states.get(laneCellKey(c.fileId, c.cellId, c.laneId))
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
      ...(c.laneId ? { laneId: c.laneId } : {}),
      targetHeadEventId: s.targetHeadEventId,
      sourceEventId: s.sourceEventId,
    })
    if (s.targetHeadEventId == null) translationsAdded++
    else translationsModified++
  }

  const summary: ChangesetSummary = { translationsAdded, translationsModified, warnings }

  // W1-B (§4): mint the compiled target.cell.commit event id for every resolved
  // precondition NOW and store it in the plan, so a crash-and-retry commit
  // re-posts the same ids (the /events layer dedupes) rather than minting fresh
  // ones. The digest (stage.ts) covers commands + preconditions only, so these
  // ids never perturb it (two prepares of the same plan still match).
  const plannedIds: PlannedEventIds = {
    setTranslation: preconditions.map((p) => ({
      fileId: p.fileId,
      cellId: p.cellId,
      ...(p.laneId ? { laneId: p.laneId } : {}),
      eventId: uuidv7(),
    })),
  }

  return stageAndRespond(db, env, {
    id,
    projectId,
    createdByUserId: String(cred.userId),
    credentialId: cred.credentialId,
    autonomyMode,
    commands,
    preconditions,
    summary,
    plannedIds,
  })
}

/**
 * Expand a DraftCells command into the SetTranslation commands the rest of the
 * prepare path already knows how to stage (AQU-1186).
 *
 * Order matters and is the cost rail: the per-changeset cap is checked BEFORE
 * any model call, so an over-cap request costs nothing and names the cap. Only
 * then does the drafting bridge run; a credit-exhausted org throws out of here
 * with a named error and never reaches stageAndRespond, which is what makes
 * "exhaustion stages nothing" true rather than aspirational.
 *
 * The returned commands carry SERVER-MINTED `aiDraft` provenance so the commit
 * lands as `ai_drafted` — a human reviews it as AI work, exactly as they would
 * an in-app draft. No auto-commit: this only ever produces a staged plan.
 */
async function expandDraftCells(
  db: AquillaDb,
  env: ExternalEnv,
  cred: ApiCredentialContext,
  projectId: string,
  cmd: DraftCellsCommand,
): Promise<Command[]> {
  const projectSettings = await loadProjectSettings(db, projectId)
  assertWithinBatchCap(cmd, completionBatchSizeFromSettings(projectSettings.settings))

  const { drafts } = await requestDrafts(env, {
    projectId,
    userId: cred.userId,
    fileId: cmd.fileId,
    cellIds: cmd.cellIds,
    ...(cmd.instructions !== undefined ? { instructions: cmd.instructions } : {}),
  })

  // Only ever stage cells the caller actually asked for: the plan a human
  // approves must match the plan the agent proposed, so a backend that widened
  // the work list (or echoed a stale one) cannot smuggle extra writes in.
  const requested = new Set(cmd.cellIds)
  const scoped = drafts.filter((d) => requested.has(d.cellId))

  if (scoped.length === 0) {
    throw new ExternalError(
      'job_failed',
      'the copilot returned no usable drafts for these cells — nothing was staged; retry, or draft fewer cells',
      { requested: cmd.cellIds.length },
    )
  }

  return scoped.map((d) => ({
    kind: 'SetTranslation' as const,
    fileId: cmd.fileId,
    cellId: d.cellId,
    value: d.value,
    ...(cmd.laneId ? { laneId: cmd.laneId } : {}),
    ...(d.aiDraft !== undefined && d.aiDraft !== null ? { aiDraft: d.aiDraft } : {}),
  }))
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

  // A referenced artifact must exist in this project. Fidelity declarations
  // below use its persisted inspection result as evidence rather than trusting
  // a filename or caller-authored manifest.
  let artifact: { id: string; kind: string; metadata: unknown } | null = null
  if (cmd.artifactId) {
    artifact = await db
      .prepare(`SELECT id, kind, metadata FROM artifacts WHERE id::text = ? AND project_id = ?`)
      .bind(cmd.artifactId, projectId)
      .first<{ id: string; kind: string; metadata: unknown }>()
    if (!artifact) {
      return errorResponse('validation_failed', `artifact ${cmd.artifactId} not found in project`)
    }
    if (artifact.kind !== 'source') {
      return errorResponse('validation_failed', `artifact ${cmd.artifactId} is not a source artifact`)
    }
  }

  const fidelity = cmd.manifest?.fidelity
  if ((fidelity === 'native' || fidelity === 'verified-recipe') && !artifact) {
    return errorResponse('validation_failed', `${fidelity} fidelity requires a preserved source artifact`)
  }
  if (fidelity === 'native' && artifact) {
    let metadata: Record<string, unknown> = {}
    if (typeof artifact.metadata === 'string') {
      try {
        const parsed = JSON.parse(artifact.metadata) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>
        }
      } catch {
        return errorResponse('validation_failed', `artifact ${artifact.id} has invalid inspection metadata`)
      }
    } else if (artifact.metadata && typeof artifact.metadata === 'object' && !Array.isArray(artifact.metadata)) {
      metadata = artifact.metadata as Record<string, unknown>
    }
    const inspection = metadata.inspection as Record<string, unknown> | undefined
    const detected = inspection?.detectedFormat
    const fileType = cmd.fileType.toLowerCase()
    const expectedProfiles: Record<string, string> = {
      usfm: 'builtin:usfm-lossless',
      sfm: 'builtin:usfm-lossless',
      docx: 'builtin:ooxml-docx',
      pptx: 'builtin:ooxml-pptx',
    }
    const expectedProfile = expectedProfiles[fileType]
    const detectedMatches = fileType === 'usfm' || fileType === 'sfm'
      ? detected === 'usfm' || detected === 'paratext-project'
      : detected === fileType
    if (!expectedProfile || cmd.manifest?.profileId !== expectedProfile || !detectedMatches) {
      return errorResponse(
        'validation_failed',
        'native fidelity requires an inspected artifact and its built-in round-trip profile',
        {
          fileType: cmd.fileType,
          profileId: cmd.manifest?.profileId,
          detectedFormat: detected ?? null,
          expectedProfile: expectedProfile ?? null,
        },
      )
    }
  }

  // Target lane ids are language tags in the current lane model. Reject an
  // unregistered lane instead of committing data the workspace cannot select.
  const projectSettings = await loadProjectSettings(db, projectId)
  const registeredLanes = new Set(
    Array.isArray(projectSettings.settings.targetLanes)
      ? projectSettings.settings.targetLanes.filter((lane): lane is string => typeof lane === 'string')
      : [],
  )
  for (const [cellIndex, cell] of cmd.cells.entries()) {
    for (const [variantIndex, variant] of (cell.variants ?? []).entries()) {
      if (variant.laneId && !registeredLanes.has(variant.laneId)) {
        return errorResponse(
          'validation_failed',
          `PlanImport.cells[${cellIndex}].variants[${variantIndex}] targets unregistered lane "${variant.laneId}"; register it with UpdateProjectSettings first`,
        )
      }
      const effectiveLanguage = variant.laneId || cmd.targetLanguage || ''
      if (variant.languageTag && variant.languageTag !== effectiveLanguage) {
        return errorResponse(
          'validation_failed',
          `PlanImport.cells[${cellIndex}].variants[${variantIndex}].languageTag must match its lane language`,
          { laneId: variant.laneId, expectedLanguageTag: effectiveLanguage },
        )
      }
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
    targetVariantsAdded: cmd.cells.reduce((count, cell) => count + (cell.variants?.length ?? 0), 0),
    ...(cmd.artifactId ? { artifactLinked: cmd.artifactId } : {}),
    warnings,
  }

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
      hideEventId: uuidv7(),
      revealEventId: uuidv7(),
      cells: cmd.cells.map((cell) => ({
        cellId: cell.id ?? uuidv7(),
        eventId: uuidv7(),
        ...(cell.variants?.length
          ? { variantEventIds: cell.variants.map(() => uuidv7()) }
          : {}),
      })),
      ...(cmd.artifactId ? { artifactBindingId: uuidv7() } : {}),
    },
  }

  return stageAndRespond(db, env, {
    id,
    projectId,
    createdByUserId: String(cred.userId),
    credentialId: cred.credentialId,
    autonomyMode,
    commands: [cmd],
    preconditions: [],
    summary,
    plannedIds,
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
 *  pinned ids (definitive project id / settings version). */
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
  return stageAndRespond(db, env, {
    id,
    projectId: changesetProjectId,
    createdByUserId: String(cred.userId),
    credentialId: cred.credentialId,
    autonomyMode,
    commands: [cmd],
    preconditions: [],
    summary,
    plannedIds,
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
    // LinkMedia is lane-independent — the default-lane state entry still
    // reports source/any-lane-target existence for the cell.
    const s = cellStates.get(laneCellKey(cmd.fileId, cmd.cellId))
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
  const plannedIds: PlannedEventIds = { linkMedia: plannedLinkMedia }

  return stageAndRespond(db, env, {
    id,
    projectId,
    createdByUserId: String(cred.userId),
    credentialId: cred.credentialId,
    autonomyMode,
    commands: [...cmds],
    preconditions: [],
    summary,
    plannedIds,
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
    // AQU-1223: the seeded language pair is part of what the approver is
    // authorizing, so it belongs in the effect summary rather than only in the
    // raw command body.
    ...(cmd.sourceLanguage !== undefined || cmd.targetLanguage !== undefined
      ? {
          newProjectLanguages: `${cmd.sourceLanguage || 'none'} → ${cmd.targetLanguage || 'none'}`,
        }
      : {}),
    warnings: [],
  }
  return stageReceiptOnlyChangeset(db, cred, urlProjectId, id, 'ask', cmd, plannedIds, summary, env)
}

/** The credential's minting user, in plain language, for the approval summary.
 *  Falls back to the numeric id when the row is unreadable — the approval page
 *  must always name SOMEONE as the incoming owner. */
async function resolveOwnerLabel(db: AquillaDb, userId: string): Promise<string> {
  const row = await db
    .prepare(`SELECT username FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ username: string | null }>()
  return row?.username ?? `user ${userId}`
}

/**
 * Prepare a CreateOrg changeset (AQU-1221). Enforces the scope rule (UNSCOPED
 * credentials only), the per-credential creation throttle, and forces ask-mode
 * so a human always approves the new tenant.
 *
 * No id is pinned in the plan: `organizations.id` is a generated identity
 * column, so unlike CreateProject there is no client-choosable id to fix at
 * prepare. The crash-retry guarantee the prepare-time-ids doctrine buys is
 * provided instead at commit, by findRecentOrgByCreator (see db/shared/orgs.ts).
 */
async function prepareCreateOrg(
  db: AquillaDb,
  cred: ApiCredentialContext,
  urlProjectId: string,
  id: string,
  autonomyMode: 'ask' | 'act',
  cmd: CreateOrgCommand,
  env: ExternalEnv,
): Promise<Response> {
  // Scope: creating a NEW tenant is outside any narrower scope by definition —
  // an org-scoped credential is confined to the org it names, a project-scoped
  // one to its project. Only an unscoped credential may mint an org.
  if (cred.projectId != null) {
    return errorResponse('scope_denied', 'a project-scoped credential cannot create organizations')
  }
  if (cred.orgId != null) {
    return errorResponse('scope_denied', 'an org-scoped credential cannot create organizations')
  }

  // Per-credential creation throttle (see CREATE_ORG_MAX_PER_CREDENTIAL).
  const identifier = `credential:${cred.credentialId}`
  const recent = await countRecentRateLimitEvents(db, 'external_create_org', identifier)
  if (recent >= CREATE_ORG_MAX_PER_CREDENTIAL) {
    return errorResponse(
      'rate_limited',
      `organization creation rate limit exceeded (max ${CREATE_ORG_MAX_PER_CREDENTIAL} per 15 minutes per credential), slow down`,
    )
  }
  await recordRateLimitEvent(db, 'external_create_org', identifier)

  // Ask-mode is FORCED, as for CreateProject: an agent must never mint a tenant
  // unattended, whatever mode its credential holds. `autonomyMode` is ignored.
  void autonomyMode

  // Effect summary the /approve page renders: what is created, and who ends up
  // owning it. The owner is resolved server-side from the credential — the
  // command has no owner parameter, so an agent can never point it elsewhere.
  const summary: ChangesetSummary = {
    command: 'CreateOrg',
    orgName: cmd.name,
    orgOwner: await resolveOwnerLabel(db, String(cred.userId)),
    warnings: [],
  }
  return stageReceiptOnlyChangeset(db, cred, urlProjectId, id, 'ask', cmd, {}, summary, env)
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

  // AQU-926 policy guard: the whole-blob replace may not CHANGE any policy
  // key's stored value (deep-equal pass-through stays valid, so read-modify-
  // write callers keep working). Re-checked at commit against the live blob.
  const changedPolicy = changedPolicyKeys(cmd.settings, current.settings)
  if (changedPolicy.length > 0) {
    return errorResponse(
      'permission_denied',
      'policy settings keys are never writable through the agent surface',
      { policyKeys: changedPolicy },
    )
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
