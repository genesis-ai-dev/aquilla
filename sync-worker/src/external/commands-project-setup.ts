// ProjectSetup — one plan, one approval for standing up a partner project
// (AQU-1294 §2.1). The command shape and its SHAPE validation; the prepare
// lives in prepare-project-setup.ts and the commit in commit-project-setup.ts.
//
// Setting up one partner project used to take six sequenced changesets in an
// order only the agent knew (PatchSettings → SetBrief → membership → import,
// each pinned to the settings version the previous one produced), so a human
// opening the approval links out of order got `plan_stale` and `duplicate_file`.
// ProjectSetup makes ONE changeset out of that: the caller supplies the desired
// end-state and the SERVER owns the order and the version guards, which is why
// `plan_stale` cannot surface from inside a plan.
//
// It is not a new privilege. Every step goes through the same module that owns
// it — the policy-direction rule (db/shared/policy-direction.ts), the brief
// merge (db/shared/brief.ts), the membership gate (commands-membership.ts),
// and the import apply (commit.ts::applyPlanImport) — so the plan can never be
// the cheaper door to any of them. Floor is the MAX of the constituent floors,
// and it is FORCED ask-mode: a composite plan touching governance, staff and
// files is exactly the thing a human must read before it runs.
//
// DEVIATION from the spec (§2.1): the optional `project` block (create the
// project inside the plan) is NOT supported. Artifacts are project-scoped, so a
// plan carrying imports cannot name a project that does not exist yet. It is
// rejected at prepare with the field named.

import { MEMBERSHIP_MAX_COMMANDS } from './commands-membership'
import { POLICY_SETTINGS_KEYS, type PatchSettingsOp } from './commands-patch-settings'
import type { BriefPatch } from '../../../db/shared/brief'
import { ROLE } from '../events/role-policy'

export interface ProjectSetupMember {
  username: string
  role: number
}

export interface ProjectSetupImport {
  artifactId: string
  fileName: string
  fileType?: string
  resultIndex?: number
  sourceLanguage?: string
  targetLanguage?: string
}

export interface ProjectSetupCommand {
  kind: 'ProjectSetup'
  /** Must equal the changeset's URL project, and that project must EXIST. */
  projectId: string
  /** Any PatchSettings key. Policy keys are split into their own step and are
   *  writable in the restrictive direction only. */
  settings?: Record<string, unknown>
  brief?: { parameters?: Record<string, string>; freeformNotes?: string }
  /** Upsert semantics: InviteMember for a new person, SetRole for a member. */
  members?: ProjectSetupMember[]
  imports?: ProjectSetupImport[]
  /** The unsupported spec §2.1 create-in-plan block. Carried through the shape
   *  validator ONLY so prepare can reject it with the field named rather than
   *  as an anonymous "unsupported field" issue. */
  project?: unknown
}

/** Static floor for index filtering. The plan's EFFECTIVE floor is computed at
 *  prepare as the max of the blocks it actually carries — projectSetupFloor. */
export const PROJECT_SETUP_REQUIRED_ROLE = ROLE.MAINTAINER

/** Spec §2.1 limits. Members reuses the membership batch cap — a composite plan
 *  is still one approval a human has to read line by line. */
export const PROJECT_SETUP_MAX_IMPORTS = 10
export const PROJECT_SETUP_MAX_MEMBERS = MEMBERSHIP_MAX_COMMANDS

const CANONICAL_ROLE_LEVELS: readonly number[] = [
  ROLE.VIEWER, ROLE.COMMENTER, ROLE.REVIEWER, ROLE.CONTRIBUTOR,
  ROLE.PROJECT_LEAD, ROLE.MAINTAINER, ROLE.OWNER,
]

const POLICY_KEY_SET = new Set(POLICY_SETTINGS_KEYS)

export interface ProjectSetupValidationIssue {
  index: number
  message: string
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Structural JSON equality — used to spot a step whose end-state already
 *  exists. Key ORDER must not matter, so this is not a stringify compare. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]))
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao)
  const bk = Object.keys(bo)
  return ak.length === bk.length && ak.every((k) => k in bo && jsonEqual(ao[k], bo[k]))
}

/**
 * Validate one raw ProjectSetup command — SHAPE only. Every authorization,
 * existence and direction check is a live prepare/commit concern.
 */
export function validateProjectSetupCommand(
  c: Record<string, unknown>,
  index: number,
  issues: ProjectSetupValidationIssue[],
): ProjectSetupCommand | null {
  if (!isNonEmptyString(c.projectId)) {
    issues.push({ index, message: 'ProjectSetup.projectId must be a non-empty string' })
    return null
  }

  let settings: Record<string, unknown> | undefined
  if (c.settings !== undefined) {
    if (!isPlainObject(c.settings)) {
      issues.push({ index, message: 'ProjectSetup.settings must be a plain object when present' })
      return null
    }
    settings = c.settings
  }

  let brief: ProjectSetupCommand['brief']
  if (c.brief !== undefined) {
    if (!isPlainObject(c.brief)) {
      issues.push({ index, message: 'ProjectSetup.brief must be a plain object when present' })
      return null
    }
    const parametersRaw = c.brief.parameters
    let parameters: Record<string, string> | undefined
    if (parametersRaw !== undefined) {
      if (!isPlainObject(parametersRaw)) {
        issues.push({ index, message: 'ProjectSetup.brief.parameters must be an object when present' })
        return null
      }
      parameters = {}
      for (const [id, value] of Object.entries(parametersRaw)) {
        if (typeof value !== 'string') {
          issues.push({ index, message: `ProjectSetup.brief.parameters.${id} must be a string` })
          return null
        }
        parameters[id] = value
      }
    }
    if (c.brief.freeformNotes !== undefined && typeof c.brief.freeformNotes !== 'string') {
      issues.push({ index, message: 'ProjectSetup.brief.freeformNotes must be a string when present' })
      return null
    }
    brief = {
      ...(parameters !== undefined ? { parameters } : {}),
      ...(c.brief.freeformNotes !== undefined ? { freeformNotes: c.brief.freeformNotes as string } : {}),
    }
  }

  let members: ProjectSetupMember[] | undefined
  if (c.members !== undefined) {
    if (!Array.isArray(c.members)) {
      issues.push({ index, message: 'ProjectSetup.members must be an array when present' })
      return null
    }
    members = []
    for (const [i, raw] of c.members.entries()) {
      if (!isPlainObject(raw) || !isNonEmptyString(raw.username) || raw.username.length > 128) {
        issues.push({ index, message: `ProjectSetup.members[${i}].username must be a non-empty string (max 128 chars)` })
        return null
      }
      if (typeof raw.role !== 'number' || !CANONICAL_ROLE_LEVELS.includes(raw.role)) {
        issues.push({ index, message: `ProjectSetup.members[${i}].role must be one of ${CANONICAL_ROLE_LEVELS.join(', ')}` })
        return null
      }
      members.push({ username: raw.username, role: raw.role })
    }
  }

  let imports: ProjectSetupImport[] | undefined
  if (c.imports !== undefined) {
    if (!Array.isArray(c.imports)) {
      issues.push({ index, message: 'ProjectSetup.imports must be an array when present' })
      return null
    }
    imports = []
    for (const [i, raw] of c.imports.entries()) {
      if (!isPlainObject(raw) || !isNonEmptyString(raw.artifactId)) {
        issues.push({ index, message: `ProjectSetup.imports[${i}].artifactId must be a non-empty string` })
        return null
      }
      if (!isNonEmptyString(raw.fileName)) {
        issues.push({ index, message: `ProjectSetup.imports[${i}].fileName must be a non-empty string` })
        return null
      }
      for (const key of ['fileType', 'sourceLanguage', 'targetLanguage'] as const) {
        if (raw[key] !== undefined && typeof raw[key] !== 'string') {
          issues.push({ index, message: `ProjectSetup.imports[${i}].${key} must be a string when present` })
          return null
        }
      }
      if (
        raw.resultIndex !== undefined &&
        (typeof raw.resultIndex !== 'number' || !Number.isInteger(raw.resultIndex) || raw.resultIndex < 0)
      ) {
        issues.push({ index, message: `ProjectSetup.imports[${i}].resultIndex must be a non-negative integer when present` })
        return null
      }
      imports.push({
        artifactId: raw.artifactId,
        fileName: raw.fileName,
        ...(raw.fileType !== undefined ? { fileType: raw.fileType as string } : {}),
        ...(raw.resultIndex !== undefined ? { resultIndex: raw.resultIndex as number } : {}),
        ...(raw.sourceLanguage !== undefined ? { sourceLanguage: raw.sourceLanguage as string } : {}),
        ...(raw.targetLanguage !== undefined ? { targetLanguage: raw.targetLanguage as string } : {}),
      })
    }
  }

  if (
    c.project === undefined &&
    settings === undefined &&
    brief === undefined &&
    members === undefined &&
    imports === undefined
  ) {
    issues.push({
      index,
      message: 'ProjectSetup needs at least one of settings, brief, members or imports',
    })
    return null
  }

  return {
    kind: 'ProjectSetup',
    projectId: c.projectId,
    ...(settings !== undefined ? { settings } : {}),
    ...(brief !== undefined ? { brief } : {}),
    ...(members !== undefined ? { members } : {}),
    ...(imports !== undefined ? { imports } : {}),
    ...(c.project !== undefined ? { project: c.project } : {}),
  }
}

/** The brief half of the command, as the shared merge/compare helpers take it. */
export function briefPatchOfSetup(cmd: ProjectSetupCommand): BriefPatch {
  return {
    ...(cmd.brief?.parameters !== undefined ? { parameters: cmd.brief.parameters } : {}),
    ...(cmd.brief?.freeformNotes !== undefined ? { freeformNotes: cmd.brief.freeformNotes } : {}),
  }
}

/** Split the settings block into the non-policy ops and the policy ops — two
 *  steps, because the policy ops are re-evaluated against the LIVE blob at
 *  commit and individually droppable, while the rest apply as one write. */
export function splitSettingsOps(
  settings: Record<string, unknown> | undefined,
): { plain: PatchSettingsOp[]; policy: PatchSettingsOp[] } {
  const plain: PatchSettingsOp[] = []
  const policy: PatchSettingsOp[] = []
  for (const [key, value] of Object.entries(settings ?? {})) {
    ;(POLICY_KEY_SET.has(key) ? policy : plain).push({ key, value })
  }
  return { plain, policy }
}
