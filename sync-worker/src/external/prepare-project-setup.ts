// ProjectSetup prepare (AQU-1294 §2.1) — the plan's effective role floor, every
// named-field rejection, and the ordered step ledger the commit walks.
//
// Split from commands-project-setup.ts (shape + validation) and
// commit-project-setup.ts (apply) purely for size; the three are one command.
//
// Every rejection here names the offending field in `details.field`. That is
// the spec's acceptance criterion: an agent that stages a bad plan must be able
// to fix ONE thing and re-prepare, not bisect a composite command by trial.

import { errorResponse } from './errors'
import { stageAndRespond } from './stage'
import { parseArtifactToCells } from './import-parse-core'
import {
  callerLevelOrDenial,
  describeChange,
  gateOne,
  type MembershipCommand,
} from './commands-membership'
import {
  previewSettingValue,
  resolveLanguageEditMinRole,
  resolveTermbaseEditMinRole,
  LANGUAGE_SETTINGS_KEYS,
  type PatchSettingsOp,
} from './commands-patch-settings'
import {
  briefPatchOfSetup,
  jsonEqual,
  splitSettingsOps,
  PROJECT_SETUP_MAX_IMPORTS,
  PROJECT_SETUP_MAX_MEMBERS,
  PROJECT_SETUP_REQUIRED_ROLE,
  type ProjectSetupCommand,
} from './commands-project-setup'
import { uuidv7 } from './uuid'
import { PLAN_IMPORT_MAX_CELLS, type PlanImportCell } from './commands'
import type {
  ChangesetSummary,
  ChangesetWarning,
  ExternalEnv,
  PlannedEventIds,
  ProjectSetupStep,
} from './types'
import type { ApiCredentialContext } from '../../../db/shared/api-credentials'
import { resolveProjectRoleShared } from '../../../db/shared/project-roles'
import { loadProjectSettings } from '../../../db/shared/projects'
import { validateSettingsKeyValue } from '../../../db/shared/project-settings-keys'
import { loosensPolicy } from '../../../db/shared/policy-direction'
import { BRIEF_SETTINGS_KEY, isBriefFieldId, isBriefPatchSatisfied, readBriefFromSettings } from '../../../db/shared/brief'
import { REQUIRED_ROLE } from '../events/role-policy'

const LANGUAGE_KEY_SET = new Set(LANGUAGE_SETTINGS_KEYS)

/** validation_failed / permission_denied with the offending field named — the
 *  spec's acceptance criterion for a rejected plan. */
function fieldError(
  code: 'validation_failed' | 'permission_denied',
  field: string,
  message: string,
  extra?: Record<string, unknown>,
): Response {
  return errorResponse(code, message, { field, ...(extra ?? {}) })
}

/**
 * The plan's effective role floor: the MAX of the floors of the blocks it
 * carries, so a composite plan is gated by its strictest constituent and can
 * never be a cheaper door to any of them.
 */
export async function projectSetupFloor(
  db: AquillaDb,
  projectId: string,
  cmd: ProjectSetupCommand,
  ops: { plain: PatchSettingsOp[]; policy: PatchSettingsOp[] },
): Promise<number> {
  // Every block's baseline is MAINTAINER (PatchSettings / SetBrief /
  // Membership all sit there); imports add PlanImport's file.create floor,
  // which is lower, so it only matters in a hypothetical imports-only plan.
  let floor: number = PROJECT_SETUP_REQUIRED_ROLE
  if (cmd.imports?.length) {
    floor = Math.max(floor, REQUIRED_ROLE['file.create'], REQUIRED_ROLE['source.cell.create'])
  }
  const allOps = [...ops.plain, ...ops.policy]
  if (allOps.some((op) => op.key === 'terminology')) {
    floor = Math.max(floor, await resolveTermbaseEditMinRole(db, projectId))
  }
  if (allOps.some((op) => LANGUAGE_KEY_SET.has(op.key))) {
    floor = Math.max(floor, await resolveLanguageEditMinRole(db, projectId))
  }
  return floor
}

/**
 * Prepare a ProjectSetup changeset (sole command, FORCED ask-mode).
 *
 * Every rejection here names the offending field. Everything that survives is
 * expanded into the ordered step ledger stored in `plannedIds.projectSetup`;
 * steps whose end-state already exists are marked `superseded` now, so the
 * approval page reports them as skipped rather than as work.
 */
export async function prepareProjectSetup(
  db: AquillaDb,
  cred: ApiCredentialContext,
  urlProjectId: string,
  id: string,
  cmd: ProjectSetupCommand,
  env: ExternalEnv,
): Promise<Response> {
  if (cmd.projectId !== urlProjectId) {
    return fieldError('validation_failed', 'projectId', 'ProjectSetup.projectId must match the changeset project')
  }
  if (cmd.project !== undefined) {
    return fieldError(
      'validation_failed',
      'project',
      'ProjectSetup cannot create the project — artifacts are project-scoped, so a plan carrying ' +
        'imports cannot target a project that does not exist yet. Create the project first with ' +
        'CreateProject (one approval), then run ProjectSetup against it.',
    )
  }

  // The project must EXIST (the plan writes into its settings, roster and files).
  const project = await db
    .prepare(`SELECT id FROM projects WHERE id = ? AND archived_at IS NULL`)
    .bind(urlProjectId)
    .first<{ id: string }>()
  if (!project) {
    return fieldError('validation_failed', 'projectId', `project ${urlProjectId} does not exist (or is archived)`)
  }

  const imports = cmd.imports ?? []
  const members = cmd.members ?? []
  if (imports.length > PROJECT_SETUP_MAX_IMPORTS) {
    return fieldError('validation_failed', 'imports', `at most ${PROJECT_SETUP_MAX_IMPORTS} imports per plan`, {
      imports: imports.length,
    })
  }
  if (members.length > PROJECT_SETUP_MAX_MEMBERS) {
    return fieldError('validation_failed', 'members', `at most ${PROJECT_SETUP_MAX_MEMBERS} members per plan`, {
      members: members.length,
    })
  }

  const ops = splitSettingsOps(cmd.settings)

  // ── settings keys: registry types first, then the policy direction ────────
  for (const op of [...ops.plain, ...ops.policy]) {
    const problem = validateSettingsKeyValue(op.key, op.value)
    if (problem) return fieldError('validation_failed', `settings.${op.key}`, problem)
  }

  const current = await loadProjectSettings(db, urlProjectId)
  const loosening = loosensPolicy(ops.policy, current.settings)
  if (loosening.length > 0) {
    return fieldError(
      'permission_denied',
      `settings.${loosening[0].key}`,
      'policy settings keys are writable in the restrictive direction only',
      {
        policyKeys: ops.policy.map((op) => op.key),
        loosening: loosening.map(({ key, current: c, proposed, reason }) => ({ key, current: c, proposed, reason })),
      },
    )
  }

  // ── brief sections ───────────────────────────────────────────────────────
  for (const sectionId of Object.keys(cmd.brief?.parameters ?? {})) {
    if (!isBriefFieldId(sectionId)) {
      return fieldError(
        'validation_failed',
        `brief.parameters.${sectionId}`,
        `unknown brief section "${sectionId}" — call describe_command("SetBrief") for the section ids`,
      )
    }
  }

  // ── role floor (live) ────────────────────────────────────────────────────
  const requiredRole = await projectSetupFloor(db, urlProjectId, cmd, ops)
  const role = await resolveProjectRoleShared(db, { id: cred.userId }, urlProjectId)
  if (!role || role.level < requiredRole) {
    return errorResponse('permission_denied', 'insufficient project role to stage this project setup', {
      requiredRole,
    })
  }

  const warnings: ChangesetWarning[] = []
  const steps: ProjectSetupStep[] = []
  const settingsChanges: Record<string, string> = {}
  const membershipChanges: string[] = []

  const skipped = (index: number, kind: string, why: string): void => {
    warnings.push({
      code: 'superseded_step',
      fileId: '',
      cellId: '',
      message: `step ${index} (${kind}) is already satisfied — ${why}`,
    })
  }

  // ── step: plain settings ─────────────────────────────────────────────────
  if (ops.plain.length > 0) {
    const index = steps.length
    const alreadyLive = ops.plain.every((op) => jsonEqual(current.settings[op.key], op.value))
    steps.push({ index, kind: 'settings', status: alreadyLive ? 'superseded' : 'pending', ops: ops.plain })
    for (const op of ops.plain) settingsChanges[op.key] = previewSettingValue(op.value)
    if (alreadyLive) skipped(index, 'settings', 'every key already holds the proposed value')
  }

  // ── step: policy settings ────────────────────────────────────────────────
  if (ops.policy.length > 0) {
    const index = steps.length
    const alreadyLive = ops.policy.every((op) => jsonEqual(current.settings[op.key], op.value))
    steps.push({ index, kind: 'policy', status: alreadyLive ? 'superseded' : 'pending', ops: ops.policy })
    for (const op of ops.policy) settingsChanges[op.key] = previewSettingValue(op.value)
    if (alreadyLive) skipped(index, 'policy', 'every policy key already holds the proposed value')
  }

  // ── step: brief ──────────────────────────────────────────────────────────
  if (cmd.brief !== undefined) {
    const index = steps.length
    const liveBrief = readBriefFromSettings(current.settings)
    const satisfied = isBriefPatchSatisfied(liveBrief, briefPatchOfSetup(cmd))
    steps.push({ index, kind: 'brief', status: satisfied ? 'superseded' : 'pending' })
    for (const [sectionId, value] of Object.entries(cmd.brief.parameters ?? {})) {
      settingsChanges[`${BRIEF_SETTINGS_KEY}.${sectionId}`] = previewSettingValue(value)
    }
    if (cmd.brief.freeformNotes !== undefined) {
      settingsChanges[`${BRIEF_SETTINGS_KEY}.freeformNotes`] = previewSettingValue(cmd.brief.freeformNotes)
    }
    if (satisfied) skipped(index, 'brief', 'every named section already holds the proposed text')
  }

  // ── step: members ────────────────────────────────────────────────────────
  if (members.length > 0) {
    const index = steps.length
    const seen = new Set<string>()
    for (const member of members) {
      const key = member.username.toLowerCase()
      if (seen.has(key)) {
        return fieldError('validation_failed', 'members', `${member.username} appears in more than one member entry`)
      }
      seen.add(key)
    }
    const callerLevel = await callerLevelOrDenial(db, cred, urlProjectId)
    if (callerLevel instanceof Response) return callerLevel

    const pinned: { username: string; userId: string; role: number }[] = []
    let allSatisfied = true
    for (const member of members) {
      // Gate with the SetRole shape: the grant cap, self-target rule and target
      // cap are identical for both kinds, and only after gateOne do we know
      // whether this is an invite or a re-role.
      const gateCmd: MembershipCommand = {
        kind: 'SetRole',
        projectId: urlProjectId,
        username: member.username,
        role: member.role,
      }
      const gate = await gateOne(db, cred, callerLevel, gateCmd)
      if (!gate.ok) return gate.response
      pinned.push({ username: gate.target.username, userId: gate.target.id, role: member.role })
      if (gate.directLevel !== member.role) allSatisfied = false
      membershipChanges.push(
        describeChange({
          kind: gate.directLevel === null ? 'InviteMember' : 'SetRole',
          projectId: urlProjectId,
          username: gate.target.username,
          role: member.role,
        }),
      )
    }
    steps.push({ index, kind: 'members', status: allSatisfied ? 'superseded' : 'pending', pinned })
    if (allSatisfied) skipped(index, 'members', 'every named person already holds the proposed role')
  }

  // ── steps: imports ───────────────────────────────────────────────────────
  const registeredLanes = new Set(
    Array.isArray(current.settings.targetLanes)
      ? current.settings.targetLanes.filter((lane): lane is string => typeof lane === 'string')
      : [],
  )
  const planNames = new Set<string>()
  let sourceCellsAdded = 0
  let filesCreated = 0

  for (const [i, spec] of imports.entries()) {
    const index = steps.length
    const nameKey = spec.fileName.toLowerCase()
    if (planNames.has(nameKey)) {
      return fieldError(
        'validation_failed',
        `imports[${i}].fileName`,
        `two imports in this plan both create a file named "${spec.fileName}"`,
      )
    }
    planNames.add(nameKey)

    // An existing active file with the same name is a hard rejection here (not
    // PlanImport's soft warning): a composite plan is a setup, and a setup that
    // quietly makes a second "Acts" is what the six-changeset flow kept doing.
    // The one exception is OUR OWN prior run — same name, already bound to the
    // same artifact — which is a superseded step.
    const existing = await db
      .prepare(
        `SELECT f.id AS id, ar.id::text AS artifact_id
           FROM files f
           LEFT JOIN artifacts ar ON ar.file_id = f.id AND ar.project_id = f.project_id
          WHERE f.project_id = ? AND f.name = ? AND f.deleted_at IS NULL
          LIMIT 1`,
      )
      .bind(urlProjectId, spec.fileName)
      .first<{ id: string; artifact_id: string | null }>()
    const alreadyImported = existing !== null && existing.artifact_id === spec.artifactId
    if (existing && !alreadyImported) {
      return fieldError(
        'validation_failed',
        `imports[${i}].fileName`,
        `a file named "${spec.fileName}" already exists in this project — rename it (RenameFile) or choose another name`,
        { fileId: existing.id },
      )
    }

    const parsed = await parseArtifactToCells(env, urlProjectId, spec.artifactId, {
      ...(spec.fileType !== undefined ? { fileType: spec.fileType } : {}),
      ...(spec.resultIndex !== undefined ? { resultIndex: spec.resultIndex } : {}),
      requireSingleResult: true,
    })
    if (!parsed.ok) return parsed.response
    const { cells, fileType } = parsed.parsed

    if (cells.length > PLAN_IMPORT_MAX_CELLS) {
      return fieldError(
        'validation_failed',
        `imports[${i}].artifactId`,
        `import parses to ${cells.length} cells, above the PlanImport cap of ${PLAN_IMPORT_MAX_CELLS}`,
        { cells: cells.length, maxCells: PLAN_IMPORT_MAX_CELLS },
      )
    }
    const unregistered = findUnregisteredLane(cells, registeredLanes)
    if (unregistered !== null) {
      return fieldError(
        'validation_failed',
        `imports[${i}].artifactId`,
        `this artifact carries translations in unregistered lane "${unregistered}"; register it in settings.targetLanes first`,
      )
    }

    steps.push({
      index,
      kind: 'import',
      status: alreadyImported ? 'superseded' : 'pending',
      artifactId: spec.artifactId,
      fileName: spec.fileName,
      fileType,
      ...(spec.resultIndex !== undefined ? { resultIndex: spec.resultIndex } : {}),
      ...(spec.sourceLanguage !== undefined ? { sourceLanguage: spec.sourceLanguage } : {}),
      ...(spec.targetLanguage !== undefined ? { targetLanguage: spec.targetLanguage } : {}),
      cellCount: cells.length,
      // Minted per import (W1-B): a crash-retry re-posts IDENTICAL ids, so the
      // /events idempotency layer dedupes instead of creating a second file.
      planned: {
        fileId: uuidv7(),
        fileEventId: uuidv7(),
        hideEventId: uuidv7(),
        revealEventId: uuidv7(),
        cells: cells.map((cell) => ({
          cellId: cell.id ?? uuidv7(),
          eventId: uuidv7(),
          ...(cell.variants?.length ? { variantEventIds: cell.variants.map(() => uuidv7()) } : {}),
        })),
        artifactBindingId: uuidv7(),
      },
      ...(alreadyImported && existing ? { fileId: existing.id } : {}),
    })
    if (alreadyImported) {
      skipped(index, 'import', `"${spec.fileName}" is already bound to this artifact`)
    } else {
      filesCreated += 1
      sourceCellsAdded += cells.length
    }
  }

  const plannedIds: PlannedEventIds = {
    projectSetup: { settingsVersion: current.version, steps },
  }

  const summary: ChangesetSummary = {
    command: 'ProjectSetup',
    projectId: urlProjectId,
    ifMatchVersion: current.version,
    ...(Object.keys(settingsChanges).length > 0 ? { settingsChanges } : {}),
    ...(membershipChanges.length > 0 ? { membershipChanges } : {}),
    ...(filesCreated > 0 ? { filesCreated } : {}),
    ...(sourceCellsAdded > 0 ? { sourceCellsAdded } : {}),
    warnings,
  }

  // Governance: FORCED ask-mode regardless of the credential's mode. A plan
  // that touches policy keys, project staff AND file contents in one write is
  // exactly what a human has to read before it runs.
  return stageAndRespond(db, env, {
    id,
    projectId: urlProjectId,
    createdByUserId: String(cred.userId),
    credentialId: cred.credentialId,
    autonomyMode: 'ask',
    commands: [cmd],
    preconditions: [],
    summary,
    plannedIds,
  })
}

/** The first variant lane a parse produced that the project cannot select, or
 *  null. Mirrors preparePlanImport's lane rule — committing data the workspace
 *  cannot show is worse than refusing the plan. */
function findUnregisteredLane(
  cells: readonly PlanImportCell[],
  registeredLanes: ReadonlySet<string>,
): string | null {
  for (const cell of cells) {
    for (const variant of cell.variants ?? []) {
      if (variant.laneId && !registeredLanes.has(variant.laneId)) return variant.laneId
    }
  }
  return null
}
