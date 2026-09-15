// PatchSettings — field-scoped project-settings write (AQU-926, command
// registry §2). Replaces named top-level settings keys under the same version
// guard + threshold re-projection as UpdateProjectSettings (the shared merge
// lives in db/shared/projects.ts::patchProjectSettingsShared), with per-key
// role floors and a hard policy-key denial. Also owns the policy-key guard the
// deprecated UpdateProjectSettings whole-blob command now enforces.

import { errorResponse, toErrorResponse } from './errors'
import { deepEqualJson } from './canonical'
import {
  receiptOnlyGates,
  writeCommittedReceipt,
  markChangesetStale,
  markChangesetSuperseded,
} from './commit-gates'
import { isPlanSatisfied } from './supersede'
import { resolveSupersedeState } from './supersede-state'
import { stageAndRespond } from './stage'
import { assertCredentialScope } from './token-bridge'
import type {
  ChangesetSummary,
  ExternalEnv,
  PlannedEventIds,
  ProvenanceChannel,
  ReceiptOnlyReceipt,
  StoredChangeset,
} from './types'
import type { ApiCredentialContext } from '../../../db/shared/api-credentials'
import { resolveProjectRoleShared } from '../../../db/shared/project-roles'
import {
  loadProjectSettings,
  normalizeSettings,
  patchProjectSettingsShared,
} from '../../../db/shared/projects'
import { validateSettingsKeyValue } from '../../../db/shared/project-settings-keys'
import { ROLE } from '../events/role-policy'

/** One top-level settings key replace. `value` is any JSON value (null stores
 *  null; JSON cannot carry undefined, so "delete key" is not expressible). */
export interface PatchSettingsOp {
  key: string
  value: unknown
}

export interface PatchSettingsCommand {
  kind: 'PatchSettings'
  projectId: string
  ops: PatchSettingsOp[]
  ifMatchVersion: number
}

/** Settings keys that govern the agent-oversight machinery itself. NEVER
 *  writable through any agent surface (permission_denied always) — an agent
 *  must not be able to loosen the gates that review its own work. Enforced for
 *  PatchSettings ops AND (as a changed-value guard) for the deprecated
 *  UpdateProjectSettings whole-blob replace. */
export const POLICY_SETTINGS_KEYS: readonly string[] = [
  'agentMemoryAutonomy',
  'validationRoleFloor',
  'validationNamedUsers',
  'validationCount',
  'validationCountAudio',
  'allowSelfValidation',
  'harmonize_min_role',
  'contributeToGlobalTm',
]

const POLICY_KEY_SET = new Set(POLICY_SETTINGS_KEYS)

/** Default floor for the `terminology` key when the org sets none — mirrors
 *  auth-worker's DEFAULT_TERMBASE_EDIT_MIN_ROLE (org-permissions.ts). */
export const DEFAULT_TERMBASE_EDIT_MIN_ROLE = ROLE.PROJECT_LEAD

/** AQU-1086: settings keys gated by the org's `languageEditMinRole` rather
 *  than the flat MAINTAINER floor. Must stay in lock-step with LANGUAGE_KEYS
 *  in auth-worker/src/routes/project-settings.ts — the two surfaces write the
 *  same blob and must not disagree about what a "language-only" change is. */
export const LANGUAGE_SETTINGS_KEYS: readonly string[] = [
  'sourceLanguage',
  'targetLanguage',
  'targetLanes',
  'archivedLanes',
]

const LANGUAGE_KEY_SET = new Set(LANGUAGE_SETTINGS_KEYS)

/** Default floor for the language keys when the org sets none — mirrors
 *  auth-worker's DEFAULT_LANGUAGE_EDIT_MIN_ROLE (org-permissions.ts). Unlike
 *  the termbase floor this default is MAINTAINER: an org opts IN to letting
 *  project leads change languages. */
export const DEFAULT_LANGUAGE_EDIT_MIN_ROLE = ROLE.MAINTAINER

export interface PatchValidationIssue {
  index: number
  message: string
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** Own-prototype-mutating keys. `merged[op.key] = op.value` in both
 *  `patchProjectSettingsShared` (db/shared/projects.ts) and the supersede
 *  comparison merge (external/supersede.ts) is a bracket assignment onto a
 *  plain object literal — one of these as `op.key` reaches `Object.prototype`'s
 *  `__proto__` accessor (or shadows `constructor`/`prototype`) before either
 *  merge ever runs. Rejected once here, at the single point both call sites'
 *  `PatchSettingsOp[]` is built from. */
const DANGEROUS_SETTINGS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Validate one raw PatchSettings command (shape only — floors and the version
 *  pin are prepare-time checks). Returns the typed command or pushes issues. */
export function validatePatchSettingsCommand(
  c: Record<string, unknown>,
  index: number,
  issues: PatchValidationIssue[],
): PatchSettingsCommand | null {
  if (!isNonEmptyString(c.projectId)) {
    issues.push({ index, message: 'PatchSettings.projectId must be a non-empty string' })
    return null
  }
  if (
    typeof c.ifMatchVersion !== 'number' ||
    !Number.isInteger(c.ifMatchVersion) ||
    c.ifMatchVersion < 0
  ) {
    issues.push({ index, message: 'PatchSettings.ifMatchVersion must be an integer >= 0' })
    return null
  }
  if (!Array.isArray(c.ops) || c.ops.length === 0) {
    issues.push({ index, message: 'PatchSettings.ops must be a non-empty array' })
    return null
  }
  const ops: PatchSettingsOp[] = []
  const seen = new Set<string>()
  for (const [opIndex, rawOp] of c.ops.entries()) {
    if (typeof rawOp !== 'object' || rawOp === null || Array.isArray(rawOp)) {
      issues.push({ index, message: `PatchSettings.ops[${opIndex}] must be an object` })
      return null
    }
    const op = rawOp as Record<string, unknown>
    if (!isNonEmptyString(op.key)) {
      issues.push({ index, message: `PatchSettings.ops[${opIndex}].key must be a non-empty string` })
      return null
    }
    if (DANGEROUS_SETTINGS_KEYS.has(op.key)) {
      issues.push({ index, message: `PatchSettings.ops[${opIndex}].key "${op.key}" is a reserved key and cannot be used` })
      return null
    }
    if (!('value' in op)) {
      issues.push({ index, message: `PatchSettings.ops[${opIndex}].value is required (null to store null)` })
      return null
    }
    // AQU-1224: a key the settings schema doesn't carry is a TYPO, not a new
    // setting — reject it here so nothing reaches the human approval queue,
    // and name the key so the caller can correct it (describe_command lists
    // the legal ones). Policy keys skip the VALUE check so they always resolve
    // to the permission_denied prepare emits for them, never a type complaint.
    if (!POLICY_KEY_SET.has(op.key)) {
      const problem = validateSettingsKeyValue(op.key, op.value)
      if (problem) {
        issues.push({ index, message: `PatchSettings.ops[${opIndex}]: ${problem}` })
        return null
      }
    }
    // A duplicate key is a caller bug (later would silently clobber earlier),
    // unlike SetTranslation's loop-generated cell batches — reject, don't warn.
    if (seen.has(op.key)) {
      issues.push({ index, message: `PatchSettings.ops[${opIndex}].key "${op.key}" appears more than once` })
      return null
    }
    seen.add(op.key)
    ops.push({ key: op.key, value: op.value })
  }
  return { kind: 'PatchSettings', projectId: c.projectId, ops, ifMatchVersion: c.ifMatchVersion }
}

/** Static index floor for PatchSettings (catalog parity): PROJECT_LEAD when
 *  every op is `terminology`, else MAINTAINER. The dynamic org floors for
 *  `terminology` (AQU-822) and the language keys (AQU-1086) are resolved at
 *  prepare/commit.
 *
 *  The catalog advertises each key's DEFAULT floor, so the language keys stay
 *  at MAINTAINER here — that is their default. An org that lowers
 *  `languageEditMinRole` to PROJECT_LEAD makes the catalog conservative for
 *  its leads (prepare/commit still admit the write), the mirror image of an
 *  org that RAISES `termbaseEditMinRole`. */
export function staticPatchSettingsFloor(cmd: PatchSettingsCommand): number {
  return cmd.ops.every((op) => op.key === 'terminology') ? ROLE.PROJECT_LEAD : ROLE.MAINTAINER
}

/** Policy keys whose STORED value would change if `candidate` replaced the
 *  live blob. Compared post-normalization (the value that would actually land,
 *  e.g. validationCount clamped to 1..15) against the normalized live read, so
 *  a read-modify-write round-trip is a clean pass-through. */
export function changedPolicyKeys(
  candidate: Record<string, unknown>,
  current: Record<string, unknown>,
): string[] {
  const normalized = normalizeSettings(candidate)
  return POLICY_SETTINGS_KEYS.filter((key) => !deepEqualJson(normalized[key], current[key]))
}

/** Compact, truncated preview of a single settings value for the approval page.
 *  Objects/arrays are JSON-stringified; everything is capped so a large nested
 *  blob renders as a short, human-scannable snippet rather than a wall of text. */
const SETTING_PREVIEW_MAX = 80
export function previewSettingValue(value: unknown): string {
  let s: string
  if (value === null) s = 'null'
  else if (value === undefined) s = 'undefined'
  else if (typeof value === 'object') s = JSON.stringify(value)
  else s = String(value)
  return s.length > SETTING_PREVIEW_MAX ? `${s.slice(0, SETTING_PREVIEW_MAX - 1)}…` : s
}

/** Effective floor for the `terminology` key: the project org's
 *  termbaseEditMinRole (org_settings blob), default PROJECT_LEAD. Mirrors
 *  auth-worker's getTermbaseEditMinRoleForProject — read with a targeted query
 *  so sync-worker never loads auth-worker code. Values outside the 100..700
 *  role ladder fall back to the default, matching extractRoleFloor. */
export async function resolveTermbaseEditMinRole(
  db: AquillaDb,
  projectId: string,
): Promise<number> {
  return resolveOrgRoleFloor(db, projectId, 'termbaseEditMinRole', DEFAULT_TERMBASE_EDIT_MIN_ROLE)
}

/** AQU-1086: effective floor for the language keys — the project org's
 *  `languageEditMinRole`, default MAINTAINER. Mirrors auth-worker's
 *  getLanguageEditMinRoleForProject. */
export async function resolveLanguageEditMinRole(
  db: AquillaDb,
  projectId: string,
): Promise<number> {
  return resolveOrgRoleFloor(db, projectId, 'languageEditMinRole', DEFAULT_LANGUAGE_EDIT_MIN_ROLE)
}

/** Shared reader for the org_settings role-ladder floors above. */
async function resolveOrgRoleFloor(
  db: AquillaDb,
  projectId: string,
  key: string,
  fallback: number,
): Promise<number> {
  const project = await db
    .prepare(`SELECT org_id FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{ org_id: number | string | null }>()
  if (!project?.org_id) return fallback
  const row = await db
    .prepare(`SELECT settings FROM org_settings WHERE org_id = ?`)
    .bind(project.org_id)
    .first<{ settings: string | null }>()
  if (!row?.settings) return fallback
  try {
    const parsed = JSON.parse(row.settings) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const raw = (parsed as Record<string, unknown>)[key]
      if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 100 && raw <= 700) return raw
    }
  } catch {
    // Malformed org settings blob — fall through to the default floor.
  }
  return fallback
}

/** Max per-key floor across the ops: `terminology` → the resolved org termbase
 *  floor; a language key → the resolved org language floor; every other key →
 *  MAINTAINER (600). Taking the MAX means a mixed batch is gated by its
 *  strictest key, so lowering one floor never widens another. */
function requiredRoleForOps(
  ops: readonly PatchSettingsOp[],
  termbaseFloor: number,
  languageFloor: number,
): number {
  let floor = 0
  for (const op of ops) {
    const keyFloor =
      op.key === 'terminology' ? termbaseFloor
      : LANGUAGE_KEY_SET.has(op.key) ? languageFloor
      : ROLE.MAINTAINER
    floor = Math.max(floor, keyFloor)
  }
  return floor
}

/** Ops naming a POLICY key → the permission_denied response, else null. */
function policyOpDenial(ops: readonly PatchSettingsOp[]): Response | null {
  const policyOps = ops.filter((op) => POLICY_KEY_SET.has(op.key))
  if (policyOps.length === 0) return null
  return errorResponse(
    'permission_denied',
    'policy settings keys are never writable through the agent surface',
    { policyKeys: policyOps.map((op) => op.key) },
  )
}

/**
 * Prepare a PatchSettings changeset (sole command): policy-key denial, dynamic
 * per-key role floors, and the settings version pin (plan_stale on drift) —
 * the same guard sequence its commit re-runs.
 */
export async function preparePatchSettings(
  db: AquillaDb,
  cred: ApiCredentialContext,
  urlProjectId: string,
  id: string,
  autonomyMode: 'ask' | 'act',
  cmd: PatchSettingsCommand,
  env: ExternalEnv,
): Promise<Response> {
  if (cmd.projectId !== urlProjectId) {
    return errorResponse('validation_failed', 'PatchSettings.projectId must match the changeset project')
  }

  const denial = policyOpDenial(cmd.ops)
  if (denial) return denial

  const [termbaseFloor, languageFloor] = await Promise.all([
    resolveTermbaseEditMinRole(db, urlProjectId),
    resolveLanguageEditMinRole(db, urlProjectId),
  ])
  const requiredRole = requiredRoleForOps(cmd.ops, termbaseFloor, languageFloor)
  const role = await resolveProjectRoleShared(db, { id: cred.userId }, urlProjectId)
  if (!role || role.level < requiredRole) {
    return errorResponse('permission_denied', 'insufficient project role for these settings keys', {
      requiredRole,
    })
  }

  const current = await loadProjectSettings(db, urlProjectId)
  if (current.version !== cmd.ifMatchVersion) {
    return errorResponse('plan_stale', 'settings version changed since prepare', {
      expected: cmd.ifMatchVersion,
      current: current.version,
    })
  }

  const plannedIds: PlannedEventIds = { patchSettings: { version: cmd.ifMatchVersion } }

  const settingsChanges: Record<string, string> = {}
  for (const op of cmd.ops) settingsChanges[op.key] = previewSettingValue(op.value)
  const summary: ChangesetSummary = {
    command: 'PatchSettings',
    projectId: urlProjectId,
    ifMatchVersion: cmd.ifMatchVersion,
    settingsChanges,
    warnings: [],
  }

  return stageAndRespond(db, env, {
    id,
    projectId: urlProjectId,
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
 * Commit a PatchSettings changeset (receipt-only). Re-runs the prepare-time
 * guards live (scope, policy denial, per-key floors), consumes the ask-mode
 * confirmation via the shared gates, then applies the per-key merge through
 * patchProjectSettingsShared — version drift maps to plan_stale, with the same
 * own-crash-retry absorption as UpdateProjectSettings.
 */
export async function commitPatchSettings(
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  cmd: PatchSettingsCommand,
  channel: ProvenanceChannel,
): Promise<Response> {
  const wasStaged = cs.status === 'staged'
  const projectId = cs.projectId

  // H1 parity with UpdateProjectSettings: the receipt-only path mints no
  // internal token, so re-assert the credential's scope ceiling here.
  try {
    await assertCredentialScope(db, cred, projectId)
  } catch (err) {
    return toErrorResponse(err)
  }

  const denial = policyOpDenial(cmd.ops)
  if (denial) return denial

  const [termbaseFloor, languageFloor] = await Promise.all([
    resolveTermbaseEditMinRole(db, projectId),
    resolveLanguageEditMinRole(db, projectId),
  ])
  const requiredRole = requiredRoleForOps(cmd.ops, termbaseFloor, languageFloor)
  const role = await resolveProjectRoleShared(db, { id: cred.userId }, projectId)
  if (!role || role.level < requiredRole) {
    return errorResponse('permission_denied', 'insufficient project role for these settings keys', {
      requiredRole,
    })
  }

  const gate = await receiptOnlyGates(db, cs)
  if (gate instanceof Response) return gate
  const confirmationId = gate.confirmationId

  const expectedVersion = cs.plannedIds?.patchSettings?.version ?? cmd.ifMatchVersion
  const result = await patchProjectSettingsShared(db, {
    projectId,
    ops: cmd.ops,
    ifMatchVersion: expectedVersion,
    updatedBy: cred.userId,
  })

  if (result.status === 'conflict') {
    // Same crash-retry disambiguation as UpdateProjectSettings: absorb the
    // conflict as idempotent success ONLY when this is a retry AND the single
    // bump past the pinned version was written by this credential's own user;
    // any other writer is a genuine concurrent write → stale.
    const bumpedByThisUser =
      result.current.version === expectedVersion + 1 &&
      result.current.updatedBy != null &&
      String(result.current.updatedBy) === String(cred.userId)
    if (!wasStaged && bumpedByThisUser) {
      return finishPatchSettingsReceipt(db, cred, cs, projectId, result.current.version, confirmationId, channel)
    }
    // P1 §3.2: a version bump by SOMEONE ELSE is only stale if the patch still
    // has work to do. When every op's key already holds the proposed value, the
    // human beat the agent to it — that is `superseded`, a healthy outcome. The
    // live blob comes from the conflict result, so no extra read.
    const live = await resolveSupersedeState(db, projectId, cs.commands, cred.username, result.current.settings)
    const superseded = isPlanSatisfied(cs.commands, live)
    if (superseded) await markChangesetSuperseded(db, cs.id)
    else await markChangesetStale(db, cs.id)
    return errorResponse(
      'plan_stale',
      superseded
        ? 'plan already satisfied — the proposed settings values are already live'
        : 'settings version changed since prepare',
      {
        expected: expectedVersion,
        current: result.current.version,
        status: superseded ? 'superseded' : 'stale',
      },
    )
  }
  if (result.status === 'error') {
    return errorResponse('job_failed', result.message)
  }

  return finishPatchSettingsReceipt(db, cred, cs, projectId, result.settings.version, confirmationId, channel)
}

async function finishPatchSettingsReceipt(
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  projectId: string,
  version: number,
  confirmationId: string | null,
  channel: ProvenanceChannel,
): Promise<Response> {
  const receipt: ReceiptOnlyReceipt = {
    credentialId: cred.credentialId,
    channel,
    changesetId: cs.id,
    command: 'PatchSettings',
    appliedAt: new Date().toISOString(),
    projectId,
    version,
  }
  await writeCommittedReceipt(db, cs.id, receipt, confirmationId)
  return Response.json({ receipt })
}
