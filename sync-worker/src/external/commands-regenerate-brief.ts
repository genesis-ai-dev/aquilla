// RegenerateBriefSummary — re-render the brief's L1 summary through the
// changeset flow (AQU-1282 §2). Receipt-only, like SetBrief: it rewrites the
// `l1Summary` / `l1GeneratedAt` / `l1ModelId` fields of the `translationBrief`
// settings key through the same version-guarded write.
//
// Why it exists: the copilot injects only the rendered L1
// (prompt-preview's `parts.brief`), and until now only the in-app builder's
// "Regenerate summary" button produced it. SetBrief now auto-renders on
// commit (best-effort), but a render can fail (backend down, credit cap) or a
// human may edit sections in-app without regenerating — this command is the
// agent's way to make the brief reach the AI on demand.
//
// Ordering at commit: the LLM render runs BEFORE `receiptOnlyGates` consumes
// the ask-mode confirmation, so a failed render answers with a named code and
// leaves the approval intact for a retry. The sections are read live (not
// pinned at prepare) — the point is to summarize what is there NOW.

import { errorResponse, toErrorResponse } from './errors'
import {
  receiptOnlyGates,
  writeCommittedReceipt,
  markChangesetStale,
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
  assembleBriefL2Markdown,
  briefFilledSectionCount,
  briefHasContent,
  BRIEF_BY_LANE_SETTINGS_KEY,
  BRIEF_SETTINGS_KEY,
  readBriefForLane,
  type TranslationBriefRecord,
} from '../../../db/shared/brief'
import { briefWriteOp, resolveStagedLane } from './commands-set-brief'
import { ROLE } from '../events/role-policy'

export interface RegenerateBriefSummaryCommand {
  kind: 'RegenerateBriefSummary'
  projectId: string
  /** Settings-blob version pin — same optimistic-concurrency guard as SetBrief. */
  ifMatchVersion: number
  /**
   * AQU-2348: the TARGET LANE whose summary to re-render (`lanes.id`). Omit
   * for the project's brief, which is the pre-AQU-2348 behaviour.
   *
   * A lane-scoped render summarizes the sections the LANE resolves to and
   * writes the L1 back into that lane's own brief only — so regenerating in
   * one lane cannot move another lane's summary, or the project's.
   */
  laneId?: string
}

/** Same floor as SetBrief: the L1 is part of the same MAINTAINER-only key. */
export const REGENERATE_BRIEF_REQUIRED_ROLE = ROLE.MAINTAINER

export interface RegenerateBriefValidationIssue {
  index: number
  message: string
}

export function validateRegenerateBriefSummaryCommand(
  c: Record<string, unknown>,
  index: number,
  issues: RegenerateBriefValidationIssue[],
): RegenerateBriefSummaryCommand | null {
  if (typeof c.projectId !== 'string' || c.projectId.length === 0) {
    issues.push({ index, message: 'RegenerateBriefSummary.projectId must be a non-empty string' })
    return null
  }
  if (
    typeof c.ifMatchVersion !== 'number' ||
    !Number.isInteger(c.ifMatchVersion) ||
    c.ifMatchVersion < 0
  ) {
    issues.push({ index, message: 'RegenerateBriefSummary.ifMatchVersion must be an integer >= 0' })
    return null
  }
  if (c.laneId !== undefined && (typeof c.laneId !== 'string' || c.laneId.length === 0)) {
    issues.push({
      index,
      message: 'RegenerateBriefSummary.laneId must be a non-empty lane id when present',
    })
    return null
  }
  return {
    kind: 'RegenerateBriefSummary',
    projectId: c.projectId,
    ifMatchVersion: c.ifMatchVersion,
    ...(c.laneId !== undefined ? { laneId: c.laneId as string } : {}),
  }
}

function roleDenied(): Response {
  return errorResponse('permission_denied', 'insufficient project role to regenerate the translation brief summary', {
    requiredRole: REGENERATE_BRIEF_REQUIRED_ROLE,
  })
}

function nothingToSummarize(): Response {
  return errorResponse(
    'validation_failed',
    'nothing to summarize — the translation brief has no filled sections or notes (write them with SetBrief first)',
  )
}

/** The L2 the render summarizes — the stored one, or a fresh assembly when a
 *  hand-edited record has none. */
function l2Of(brief: TranslationBriefRecord): string {
  return brief.l2Markdown.trim() || assembleBriefL2Markdown(brief)
}

/**
 * Prepare (sole command): role floor, version pin, and "is there anything to
 * summarize" — a brief with no content would only burn a model call.
 */
export async function prepareRegenerateBriefSummary(
  db: AquillaDb,
  cred: ApiCredentialContext,
  urlProjectId: string,
  id: string,
  autonomyMode: 'ask' | 'act',
  cmd: RegenerateBriefSummaryCommand,
  env: ExternalEnv,
): Promise<Response> {
  if (cmd.projectId !== urlProjectId) {
    return errorResponse('validation_failed', 'RegenerateBriefSummary.projectId must match the changeset project')
  }

  const role = await resolveProjectRoleShared(db, { id: cred.userId }, urlProjectId)
  if (!role || role.level < REGENERATE_BRIEF_REQUIRED_ROLE) return roleDenied()

  const current = await loadProjectSettings(db, urlProjectId)
  if (current.version !== cmd.ifMatchVersion) {
    return errorResponse('plan_stale', 'settings version changed since prepare', {
      expected: cmd.ifMatchVersion,
      current: current.version,
    })
  }

  // AQU-2348: same lane resolution as SetBrief, and the resolved `lanes.id` is
  // what gets staged.
  const staged = resolveStagedLane(cmd, current.lanes ?? [], 'RegenerateBriefSummary.laneId')
  if (!staged.ok) return errorResponse('validation_failed', staged.message)

  const brief = readBriefForLane(current.settings, staged.cmd.laneId).brief
  if (!briefHasContent(brief)) return nothingToSummarize()

  const plannedIds: PlannedEventIds = { regenerateBriefSummary: { version: cmd.ifMatchVersion } }
  const summary: ChangesetSummary = {
    command: 'RegenerateBriefSummary',
    projectId: urlProjectId,
    ifMatchVersion: cmd.ifMatchVersion,
    settingsChanges: {
      [`${l1ChangeKey(staged.cmd.laneId)}`]: `(regenerated from ${briefFilledSectionCount(brief)} sections)`,
    },
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

/** The settings path the L1 write touches, named for the approval page so a
 *  lane-scoped regenerate does not read as a project-wide one. */
function l1ChangeKey(laneId: string | undefined): string {
  return laneId === undefined
    ? `${BRIEF_SETTINGS_KEY}.l1Summary`
    : `${BRIEF_BY_LANE_SETTINGS_KEY}.${laneId}.l1Summary`
}

/**
 * Commit (receipt-only): scope + role live, version drift check, the render
 * (BEFORE the gates, so a failed render leaves the approval unconsumed), then
 * the gates and the guarded write of the L1 fields.
 */
export async function commitRegenerateBriefSummary(
  db: AquillaDb,
  env: ExternalEnv,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  cmd: RegenerateBriefSummaryCommand,
  channel: ProvenanceChannel,
): Promise<Response> {
  const wasStaged = cs.status === 'staged'
  const projectId = cs.projectId

  try {
    await assertCredentialScope(db, cred, projectId)
  } catch (err) {
    return toErrorResponse(err)
  }

  const role = await resolveProjectRoleShared(db, { id: cred.userId }, projectId)
  if (!role || role.level < REGENERATE_BRIEF_REQUIRED_ROLE) return roleDenied()

  const expectedVersion = cs.plannedIds?.regenerateBriefSummary?.version ?? cmd.ifMatchVersion
  const current = await loadProjectSettings(db, projectId)
  // The lane's own brief when it has one, the project's otherwise — the same
  // record the copilot resolves for that lane, which is what the summary has
  // to describe.
  const live = readBriefForLane(current.settings, cmd.laneId).brief

  // Drift check BEFORE the paid render: patchProjectSettingsShared would
  // refuse the write anyway, but only after a model call was spent.
  if (current.version !== expectedVersion) {
    // Crash-retry: the single bump past the pin was this user's own write, and
    // the summary is already there — report it rather than rendering twice.
    const bumpedByThisUser =
      current.version === expectedVersion + 1 &&
      current.updatedBy != null &&
      String(current.updatedBy) === String(cred.userId)
    if (!wasStaged && bumpedByThisUser && live?.l1Summary) {
      return finishReceipt(
        db,
        cred,
        cs,
        projectId,
        current.version,
        cs.confirmationId ?? null,
        channel,
        live,
        cmd.laneId,
      )
    }
    await markChangesetStale(db, cs.id)
    return errorResponse('plan_stale', 'settings version changed since prepare', {
      expected: expectedVersion,
      current: current.version,
      status: 'stale',
    })
  }

  if (!briefHasContent(live)) return nothingToSummarize()

  const rendered = await renderBriefSummary(env, { projectId, userId: cred.userId, l2Markdown: l2Of(live) })
  if (!rendered.ok) {
    // not_configured is a deployment fact the agent cannot act on — job_failed.
    const code = rendered.code === 'not_configured' ? 'job_failed' : rendered.code
    return errorResponse(code, `${rendered.message} — the approval was not consumed; retry when the backend is available`)
  }

  const gate = await receiptOnlyGates(db, cs)
  if (gate instanceof Response) return gate
  const confirmationId = gate.confirmationId

  const now = new Date().toISOString()
  const nextBrief = applyBriefL1Summary(live, rendered.summary, rendered.model, now)
  const result = await patchProjectSettingsShared(db, {
    projectId,
    ops: [briefWriteOp(current.settings, cmd.laneId, nextBrief)],
    ifMatchVersion: expectedVersion,
    updatedBy: cred.userId,
  })

  if (result.status === 'conflict') {
    await markChangesetStale(db, cs.id)
    return errorResponse('plan_stale', 'settings version changed during commit', {
      expected: expectedVersion,
      current: result.current.version,
      status: 'stale',
    })
  }
  if (result.status === 'error') return errorResponse('job_failed', result.message)

  return finishReceipt(
    db,
    cred,
    cs,
    projectId,
    result.settings.version,
    confirmationId,
    channel,
    nextBrief,
    cmd.laneId,
  )
}

async function finishReceipt(
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  projectId: string,
  version: number,
  confirmationId: string | null,
  channel: ProvenanceChannel,
  brief: TranslationBriefRecord,
  laneId?: string,
): Promise<Response> {
  const receipt: ReceiptOnlyReceipt = {
    credentialId: cred.credentialId,
    channel,
    changesetId: cs.id,
    command: 'RegenerateBriefSummary',
    appliedAt: new Date().toISOString(),
    projectId,
    version,
    ...(laneId !== undefined ? { laneId } : {}),
    briefSummaryChars: (brief.l1Summary ?? '').length,
    l1ModelId: brief.l1ModelId ?? 'unknown',
  }
  await writeCommittedReceipt(db, cs.id, receipt, confirmationId)
  return Response.json({ receipt })
}
