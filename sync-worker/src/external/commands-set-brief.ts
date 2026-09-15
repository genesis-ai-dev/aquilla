// SetBrief — create/update a project's translation brief through the changeset
// flow (AQU-1227). Receipt-only, like PatchSettings: the brief is the
// `translationBrief` key of the project settings blob, so this rides the same
// version-guarded write (patchProjectSettingsShared) and lands in exactly the
// row the in-app brief builder reads. Nothing downstream needs teaching about
// an "API brief" — the autopilot brief gate, the builder, and the agent's
// prompt augmentation all read the one key.
//
// Why a dedicated command rather than `PatchSettings { key: 'translationBrief' }`:
// PatchSettings replaces a key WHOLESALE, so an agent updating one section
// would have to read-modify-write the whole record and would clobber L1 and the
// other sections on any mistake. SetBrief takes a partial patch, validates the
// field ids against the code-owned schema, and does the merge + L2 reassembly
// server-side. It is an ergonomics and validation layer over the same write —
// deliberately NOT a privilege change: the role floor is MAINTAINER, the same
// floor PatchSettings applies to this key, so SetBrief is never the cheaper
// door to the same settings blob.

import { errorResponse, toErrorResponse } from './errors'
import {
  receiptOnlyGates,
  writeCommittedReceipt,
  markChangesetStale,
  markChangesetSuperseded,
} from './commit-gates'
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
import { loadProjectSettings, patchProjectSettingsShared } from '../../../db/shared/projects'
import {
  applyBriefPatch,
  BRIEF_FIELD_IDS,
  BRIEF_SETTINGS_KEY,
  emptyBriefRecord,
  isBriefFieldId,
  isBriefPatchSatisfied,
  readBriefFromSettings,
  type BriefPatch,
} from '../../../db/shared/brief'
import { ROLE } from '../events/role-policy'

export interface SetBriefCommand {
  kind: 'SetBrief'
  projectId: string
  /** Partial map of brief field id → answer text. Only the named fields are
   *  written; every other field keeps its live value. */
  parameters?: Record<string, string>
  /** Replaces the freeform notes block. Omit to leave it untouched. */
  freeformNotes?: string
  /** Settings-blob version pin — the brief lives in the settings blob, so the
   *  same optimistic-concurrency guard as PatchSettings applies. */
  ifMatchVersion: number
}

/** Same floor PatchSettings applies to a non-`terminology` settings key. Kept
 *  identical on purpose — see the header note on not being a cheaper door. */
export const SET_BRIEF_REQUIRED_ROLE = ROLE.MAINTAINER

/** Per-field answer cap. The brief is injected into every copilot prompt via
 *  its L1/L2, so an unbounded field is a token-budget hazard, not just a big
 *  string. Generous enough for a real answer paragraph. */
export const BRIEF_FIELD_MAX_CHARS = 4000
/** Freeform notes hold the leftovers that don't fit a field — a little roomier. */
export const BRIEF_NOTES_MAX_CHARS = 8000

export interface SetBriefValidationIssue {
  index: number
  message: string
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Validate one raw SetBrief command. Shape only — the role floor and the
 * version pin are prepare-time checks. Unknown field ids are rejected here
 * (rather than silently dropped) so a typo'd section never stages as a plan
 * that would apply nothing.
 */
export function validateSetBriefCommand(
  c: Record<string, unknown>,
  index: number,
  issues: SetBriefValidationIssue[],
): SetBriefCommand | null {
  if (!isNonEmptyString(c.projectId)) {
    issues.push({ index, message: 'SetBrief.projectId must be a non-empty string' })
    return null
  }
  if (
    typeof c.ifMatchVersion !== 'number' ||
    !Number.isInteger(c.ifMatchVersion) ||
    c.ifMatchVersion < 0
  ) {
    issues.push({ index, message: 'SetBrief.ifMatchVersion must be an integer >= 0' })
    return null
  }
  if (c.parameters === undefined && c.freeformNotes === undefined) {
    issues.push({
      index,
      message: 'SetBrief needs at least one of parameters or freeformNotes',
    })
    return null
  }

  let parameters: Record<string, string> | undefined
  if (c.parameters !== undefined) {
    if (!isPlainObject(c.parameters)) {
      issues.push({ index, message: 'SetBrief.parameters must be an object when present' })
      return null
    }
    const entries = Object.entries(c.parameters)
    if (entries.length === 0) {
      issues.push({ index, message: 'SetBrief.parameters must name at least one field when present' })
      return null
    }
    parameters = {}
    for (const [id, value] of entries) {
      if (!isBriefFieldId(id)) {
        issues.push({
          index,
          message: `SetBrief.parameters has unknown brief field "${id}" — known fields: ${BRIEF_FIELD_IDS.join(', ')}`,
        })
        return null
      }
      if (typeof value !== 'string') {
        issues.push({ index, message: `SetBrief.parameters.${id} must be a string` })
        return null
      }
      if (value.length > BRIEF_FIELD_MAX_CHARS) {
        issues.push({
          index,
          message: `SetBrief.parameters.${id} exceeds ${BRIEF_FIELD_MAX_CHARS} characters`,
        })
        return null
      }
      parameters[id] = value
    }
  }

  if (c.freeformNotes !== undefined) {
    if (typeof c.freeformNotes !== 'string') {
      issues.push({ index, message: 'SetBrief.freeformNotes must be a string when present' })
      return null
    }
    if (c.freeformNotes.length > BRIEF_NOTES_MAX_CHARS) {
      issues.push({
        index,
        message: `SetBrief.freeformNotes exceeds ${BRIEF_NOTES_MAX_CHARS} characters`,
      })
      return null
    }
  }

  return {
    kind: 'SetBrief',
    projectId: c.projectId,
    ...(parameters !== undefined ? { parameters } : {}),
    ...(c.freeformNotes !== undefined ? { freeformNotes: c.freeformNotes as string } : {}),
    ifMatchVersion: c.ifMatchVersion,
  }
}

/** The content half of the command, as the shared merge/compare helpers take it. */
export function briefPatchOf(cmd: SetBriefCommand): BriefPatch {
  return {
    ...(cmd.parameters !== undefined ? { parameters: cmd.parameters } : {}),
    ...(cmd.freeformNotes !== undefined ? { freeformNotes: cmd.freeformNotes } : {}),
  }
}

/** Compact per-section preview for the approval page — the human approving a
 *  brief write should see WHICH sections change and roughly what lands. */
const SECTION_PREVIEW_MAX = 80
function previewSection(value: string): string {
  const s = value.trim() === '' ? '(cleared)' : value.trim()
  return s.length > SECTION_PREVIEW_MAX ? `${s.slice(0, SECTION_PREVIEW_MAX - 1)}…` : s
}

function briefChangesPreview(cmd: SetBriefCommand): Record<string, string> {
  const changes: Record<string, string> = {}
  for (const [id, value] of Object.entries(cmd.parameters ?? {})) {
    changes[`${BRIEF_SETTINGS_KEY}.${id}`] = previewSection(value)
  }
  if (cmd.freeformNotes !== undefined) {
    changes[`${BRIEF_SETTINGS_KEY}.freeformNotes`] = previewSection(cmd.freeformNotes)
  }
  return changes
}

/** Author stamp written into the brief record — matches what the in-app
 *  builder stores (the acting user, not the credential). */
function briefAuthor(cred: ApiCredentialContext): string {
  return cred.username || String(cred.userId)
}

/**
 * Prepare a SetBrief changeset (sole command): role floor and the settings
 * version pin — the same guard sequence its commit re-runs.
 */
export async function prepareSetBrief(
  db: AquillaDb,
  cred: ApiCredentialContext,
  urlProjectId: string,
  id: string,
  autonomyMode: 'ask' | 'act',
  cmd: SetBriefCommand,
  env: ExternalEnv,
): Promise<Response> {
  if (cmd.projectId !== urlProjectId) {
    return errorResponse('validation_failed', 'SetBrief.projectId must match the changeset project')
  }

  const role = await resolveProjectRoleShared(db, { id: cred.userId }, urlProjectId)
  if (!role || role.level < SET_BRIEF_REQUIRED_ROLE) {
    return errorResponse('permission_denied', 'insufficient project role to write the translation brief', {
      requiredRole: SET_BRIEF_REQUIRED_ROLE,
    })
  }

  const current = await loadProjectSettings(db, urlProjectId)
  if (current.version !== cmd.ifMatchVersion) {
    return errorResponse('plan_stale', 'settings version changed since prepare', {
      expected: cmd.ifMatchVersion,
      current: current.version,
    })
  }

  const plannedIds: PlannedEventIds = { setBrief: { version: cmd.ifMatchVersion } }

  const summary: ChangesetSummary = {
    command: 'SetBrief',
    projectId: urlProjectId,
    ifMatchVersion: cmd.ifMatchVersion,
    settingsChanges: briefChangesPreview(cmd),
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
 * Commit a SetBrief changeset (receipt-only). Re-runs the prepare-time guards
 * live (scope, role floor), consumes the ask-mode confirmation, then merges the
 * patch into the live brief and writes it back as the `translationBrief`
 * settings key through the shared version-guarded write.
 */
export async function commitSetBrief(
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  cmd: SetBriefCommand,
  channel: ProvenanceChannel,
): Promise<Response> {
  const wasStaged = cs.status === 'staged'
  const projectId = cs.projectId

  // Receipt-only path mints no internal token, so re-assert the credential's
  // scope ceiling here (H1 parity with PatchSettings).
  try {
    await assertCredentialScope(db, cred, projectId)
  } catch (err) {
    return toErrorResponse(err)
  }

  const role = await resolveProjectRoleShared(db, { id: cred.userId }, projectId)
  if (!role || role.level < SET_BRIEF_REQUIRED_ROLE) {
    return errorResponse('permission_denied', 'insufficient project role to write the translation brief', {
      requiredRole: SET_BRIEF_REQUIRED_ROLE,
    })
  }

  const gate = await receiptOnlyGates(db, cs)
  if (gate instanceof Response) return gate
  const confirmationId = gate.confirmationId

  const expectedVersion = cs.plannedIds?.setBrief?.version ?? cmd.ifMatchVersion
  const now = new Date().toISOString()
  const author = briefAuthor(cred)

  // Read the live brief and merge here rather than baking a finished record
  // into the plan at prepare: the plan stores only the sections the caller
  // NAMED, so the unnamed ones are resolved against whatever is live at apply
  // time. Costs one extra read of the settings row (patchProjectSettingsShared
  // re-reads it under the version guard, which stays the authoritative check).
  const current = await loadProjectSettings(db, projectId)
  const live = readBriefFromSettings(current.settings)
  const nextBrief = applyBriefPatch(live ?? emptyBriefRecord(author, now), briefPatchOf(cmd), author, now)

  const result = await patchProjectSettingsShared(db, {
    projectId,
    ops: [{ key: BRIEF_SETTINGS_KEY, value: nextBrief }],
    ifMatchVersion: expectedVersion,
    updatedBy: cred.userId,
  })

  if (result.status === 'conflict') {
    // Same crash-retry disambiguation as PatchSettings: absorb the conflict as
    // idempotent success ONLY when this is a retry AND the single bump past the
    // pinned version was written by this credential's own user.
    const bumpedByThisUser =
      result.current.version === expectedVersion + 1 &&
      result.current.updatedBy != null &&
      String(result.current.updatedBy) === String(cred.userId)
    if (!wasStaged && bumpedByThisUser) {
      return finishSetBriefReceipt(db, cred, cs, projectId, result.current.version, confirmationId, channel)
    }
    // A bump by someone else is only stale if the patch still has work to do.
    // When every named section already holds the proposed text, the human beat
    // the agent to it — that is `superseded`, a healthy outcome.
    const liveNow = readBriefFromSettings(result.current.settings)
    const superseded = isBriefPatchSatisfied(liveNow, briefPatchOf(cmd))
    if (superseded) await markChangesetSuperseded(db, cs.id)
    else await markChangesetStale(db, cs.id)
    return errorResponse(
      'plan_stale',
      superseded
        ? 'plan already satisfied — the proposed brief sections are already live'
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

  return finishSetBriefReceipt(db, cred, cs, projectId, result.settings.version, confirmationId, channel)
}

async function finishSetBriefReceipt(
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
    command: 'SetBrief',
    appliedAt: new Date().toISOString(),
    projectId,
    version,
  }
  await writeCommittedReceipt(db, cs.id, receipt, confirmationId)
  return Response.json({ receipt })
}
