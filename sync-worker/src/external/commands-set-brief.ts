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
import { renderBriefSummary } from './brief-summary-bridge'
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
  applyBriefL1Summary,
  applyBriefPatch,
  BRIEF_BY_LANE_SETTINGS_KEY,
  BRIEF_FIELD_IDS,
  BRIEF_SETTINGS_KEY,
  emptyBriefRecord,
  isBriefFieldId,
  isBriefPatchSatisfied,
  readBriefForLane,
  readLaneBriefMap,
  readOwnedBriefForLane,
  type BriefPatch,
  type TranslationBriefRecord,
} from '../../../db/shared/brief'
import { withLaneMemoryValue } from '../../../db/shared/lane-memory'
import type { ProjectLaneRecord } from '../../../db/shared/lanes'
import { laneContextFrom, resolveTargetLaneId } from './external-lane'
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
  /**
   * AQU-2348: the TARGET LANE this brief belongs to (`lanes.id`). Omit to
   * write the project's brief, which stays the default for every lane that
   * has none — so omitting it is exactly the pre-AQU-2348 behaviour.
   *
   * A lane-scoped write touches ONLY `translationBriefByLane[laneId]`: the
   * project's brief and every other lane's are left alone. The first such
   * write merges its patch onto the brief the lane currently RESOLVES to
   * (the project's, when the lane owns none), so customizing a lane copies
   * the project's answers rather than starting from a blank brief.
   */
  laneId?: string
}

/** Same floor PatchSettings applies to the `translationBrief` key. Kept
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
  if (c.laneId !== undefined && !isNonEmptyString(c.laneId)) {
    issues.push({ index, message: 'SetBrief.laneId must be a non-empty lane id when present' })
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
    ...(c.laneId !== undefined ? { laneId: c.laneId as string } : {}),
  }
}

/** The `settingsChanges` / plan prefix naming what a brief write touches. A
 *  lane-scoped write names the lane, so the human on /approve/:id can see it
 *  is one lane's brief and not the project's. */
function briefChangePrefix(cmd: SetBriefCommand): string {
  return cmd.laneId === undefined
    ? BRIEF_SETTINGS_KEY
    : `${BRIEF_BY_LANE_SETTINGS_KEY}.${cmd.laneId}`
}

/** The content half of the command, as the shared merge/compare helpers take it. */
export function briefPatchOf(cmd: SetBriefCommand): BriefPatch {
  return {
    ...(cmd.parameters !== undefined ? { parameters: cmd.parameters } : {}),
    ...(cmd.freeformNotes !== undefined ? { freeformNotes: cmd.freeformNotes } : {}),
  }
}

/**
 * The settings write op for a brief record: the project's key, or the lane's
 * slot inside the per-lane map.
 *
 * `patchProjectSettingsShared` replaces a key WHOLESALE, so a lane-scoped
 * write has to resend the whole map with this lane's slot replaced — hence
 * `withLaneMemoryValue` over the map read from the blob this write is pinned
 * to. Every OTHER lane's brief is carried across untouched, which is the
 * difference between customizing one lane and clearing the rest.
 */
export function briefWriteOp(
  settings: Record<string, unknown>,
  laneId: string | undefined,
  brief: TranslationBriefRecord,
): { key: string; value: unknown } {
  if (laneId === undefined) return { key: BRIEF_SETTINGS_KEY, value: brief }
  return {
    key: BRIEF_BY_LANE_SETTINGS_KEY,
    value: withLaneMemoryValue(readLaneBriefMap(settings), laneId, brief),
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
  const prefix = briefChangePrefix(cmd)
  for (const [id, value] of Object.entries(cmd.parameters ?? {})) {
    changes[`${prefix}.${id}`] = previewSection(value)
  }
  if (cmd.freeformNotes !== undefined) {
    changes[`${prefix}.freeformNotes`] = previewSection(cmd.freeformNotes)
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

  // AQU-2348: a lane-scoped write must name a real, unarchived TARGET lane of
  // this project. Resolved HERE (not at validate) because it needs the lane
  // rows, and the resolved `lanes.id` is what gets staged — so an approval a
  // human reads names the same lane the commit writes.
  //
  // Visibility is passed as "sees everything" deliberately: the lane read wall
  // never hides a lane from a caller at MAINTAINER or above, and this command's
  // floor already is MAINTAINER, so there is no hidden lane left to conceal.
  const staged = resolveStagedLane(cmd, current.lanes ?? [])
  if (!staged.ok) return errorResponse('validation_failed', staged.message)

  const plannedIds: PlannedEventIds = { setBrief: { version: cmd.ifMatchVersion } }

  const summary: ChangesetSummary = {
    command: 'SetBrief',
    projectId: urlProjectId,
    ifMatchVersion: cmd.ifMatchVersion,
    settingsChanges: briefChangesPreview(staged.cmd),
    ...(staged.cmd.laneId !== undefined ? { laneId: staged.cmd.laneId } : {}),
    warnings: [],
  }

  return stageAndRespond(db, env, {
    id,
    projectId: urlProjectId,
    createdByUserId: String(cred.userId),
    credentialId: cred.credentialId,
    autonomyMode,
    commands: [staged.cmd],
    preconditions: [],
    summary,
    plannedIds,
  })
}

/**
 * Resolve a brief command's `laneId` against the project's lane rows, giving
 * back the command to stage with the canonical `lanes.id`.
 *
 * Shared by SetBrief and RegenerateBriefSummary so both answer a bad lane the
 * same way `resolveTargetLaneId` answers everywhere else on this API: a
 * language, a legacy tag, or an archived or absent lane is `validation_failed`
 * with the message that names the discovery endpoint.
 */
export function resolveStagedLane<T extends { laneId?: string }>(
  cmd: T,
  lanes: readonly ProjectLaneRecord[],
  where = 'SetBrief.laneId',
): { ok: true; cmd: T } | { ok: false; message: string } {
  if (cmd.laneId === undefined) return { ok: true, cmd }
  const resolved = resolveTargetLaneId(cmd.laneId, where, laneContextFrom(lanes, null))
  if (!resolved.ok) return { ok: false, message: resolved.message }
  return { ok: true, cmd: { ...cmd, laneId: resolved.lane.id } }
}

/**
 * Commit a SetBrief changeset (receipt-only). Re-runs the prepare-time guards
 * live (scope, role floor), consumes the ask-mode confirmation, then merges the
 * patch into the live brief and writes it back as the `translationBrief`
 * settings key through the shared version-guarded write.
 */
export async function commitSetBrief(
  db: AquillaDb,
  env: ExternalEnv,
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
  // AQU-2348: for a lane-scoped write this reads the brief the lane RESOLVES
  // to — its own copy, or the project's when it has none — so the first
  // customization of a lane carries the project's answers across instead of
  // publishing a brief with every unnamed section blank.
  const live = readBriefForLane(current.settings, cmd.laneId).brief
  const nextBrief = applyBriefPatch(live ?? emptyBriefRecord(author, now), briefPatchOf(cmd), author, now)

  const result = await patchProjectSettingsShared(db, {
    projectId,
    ops: [briefWriteOp(current.settings, cmd.laneId, nextBrief)],
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
      return finishSetBriefReceipt(
        db,
        cred,
        cs,
        projectId,
        result.current.version,
        confirmationId,
        channel,
        {
          rendered: false,
          reason: 'crash-retry — the sections were already committed; use RegenerateBriefSummary',
        },
        cmd.laneId,
      )
    }
    // A bump by someone else is only stale if the patch still has work to do.
    // When every named section already holds the proposed text, the human beat
    // the agent to it — that is `superseded`, a healthy outcome.
    // Lane-aware: a lane-scoped patch is "already satisfied" only once THAT
    // lane OWNS the proposed text. Resolving it through the project fallback
    // would let a project-wide write retire a pending lane customization —
    // and the lane would then still be inheriting, which is not what was asked.
    const liveNow = readOwnedBriefForLane(result.current.settings, cmd.laneId)
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

  // AQU-1282: the sections are committed; now try to make them reach the
  // copilot. Best-effort — a failed render is reported in the receipt, never
  // a failed commit, and RegenerateBriefSummary re-runs it on demand.
  const { version, briefSummary } = await autoRenderL1(
    db,
    env,
    cred,
    projectId,
    nextBrief,
    result.settings.version,
    result.settings.settings,
    cmd.laneId,
  )
  return finishSetBriefReceipt(
    db,
    cred,
    cs,
    projectId,
    version,
    confirmationId,
    channel,
    briefSummary,
    cmd.laneId,
  )
}

/**
 * Render the L1 for the just-written brief and store it against the version
 * the sections write returned. Returns the version a caller should pin next
 * (the L1 write bumps it again on success) plus the receipt fact.
 */
async function autoRenderL1(
  db: AquillaDb,
  env: ExternalEnv,
  cred: ApiCredentialContext,
  projectId: string,
  brief: TranslationBriefRecord,
  version: number,
  settings: Record<string, unknown>,
  laneId: string | undefined,
): Promise<{ version: number; briefSummary: NonNullable<ReceiptOnlyReceipt['briefSummary']> }> {
  const rendered = await renderBriefSummary(env, {
    projectId,
    userId: cred.userId,
    l2Markdown: brief.l2Markdown,
  })
  if (!rendered.ok) {
    return { version, briefSummary: { rendered: false, reason: `${rendered.code}: ${rendered.message}` } }
  }
  const withL1 = applyBriefL1Summary(brief, rendered.summary, rendered.model, new Date().toISOString())
  const write = await patchProjectSettingsShared(db, {
    projectId,
    // The L1 belongs to the brief that was just written, so it lands in the
    // same key — a lane's summary must not overwrite the project's.
    ops: [briefWriteOp(settings, laneId, withL1)],
    ifMatchVersion: version,
    updatedBy: cred.userId,
  })
  if (write.status !== 'ok') {
    const reason = write.status === 'conflict' ? 'settings changed while the summary was rendering' : write.message
    return { version, briefSummary: { rendered: false, reason } }
  }
  return {
    version: write.settings.version,
    briefSummary: { rendered: true, chars: rendered.summary.length, model: rendered.model },
  }
}

async function finishSetBriefReceipt(
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  projectId: string,
  version: number,
  confirmationId: string | null,
  channel: ProvenanceChannel,
  briefSummary: NonNullable<ReceiptOnlyReceipt['briefSummary']>,
  laneId?: string,
): Promise<Response> {
  const receipt: ReceiptOnlyReceipt = {
    credentialId: cred.credentialId,
    channel,
    changesetId: cs.id,
    command: 'SetBrief',
    appliedAt: new Date().toISOString(),
    projectId,
    version,
    ...(laneId !== undefined ? { laneId } : {}),
    briefSummary,
  }
  await writeCommittedReceipt(db, cs.id, receipt, confirmationId)
  return Response.json({ receipt })
}
