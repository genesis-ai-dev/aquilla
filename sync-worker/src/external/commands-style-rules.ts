// ReviewStyleRules (AQU-2195): approve, reject or edit style rules in bulk.
//
// The "Style rules" section of the Rules page lives in the `style_rules` table
// (db/shared/style-rules.ts). Extracting rules from the knowledge base proposes
// them in the hundreds; a person then approves a few and rejects the rest. This
// command lets an agent do that pass through the same changeset flow as every
// other write.
//
// Like the Living Memory commands (commands-memory.ts) this is RECEIPT-ONLY:
// style rules are a plain table, not event-sourced, so there are no compiled
// events and no cell preconditions, only a row write guarded by the changeset
// state machine. It is a sole command in its changeset.
//
// The floor is PROJECT_LEAD, the same floor the in-app review and edit routes
// ask for (auth-worker routes/style-rules.ts). Two gates apply, and both are
// the same floor:
//   • the caller's own role, checked at prepare and re-resolved live at commit,
//     so a credential whose owner was demoted after staging cannot land it;
//   • the confirming human in ask mode. Approving a rule puts an instruction
//     into every future draft, so unlike a memory proposal there is no "lands
//     as proposed" fallback for a lesser approver: a confirmation from anyone
//     below PROJECT_LEAD refuses the commit. (The approval route already
//     enforces the plan's floor; this re-checks the live role at commit, which
//     can have dropped since.) Act mode with a PROJECT_LEAD credential applies
//     directly.
//
// The batch is all or nothing. Commit checks every decision against the live
// rows under a lock and writes only if all of them pass; any missing,
// org-inherited, wrongly-stated or stale (`ifMatchVersion`) rule refuses the
// whole commit with one entry per bad decision.

import { errorResponse, toErrorResponse } from './errors'
import { receiptOnlyGates, writeCommittedReceipt } from './commit-gates'
import { stageAndRespond } from './stage'
import { assertCredentialScope } from './token-bridge'
import type {
  ChangesetSummary,
  ExternalEnv,
  PlannedEventIds,
  ProvenanceChannel,
  StoredChangeset,
  StyleRuleReviewReceipt,
} from './types'
import type { ApiCredentialContext } from '../../../db/shared/api-credentials'
import { resolveProjectRoleShared } from '../../../db/shared/project-roles'
import {
  STYLE_RULE_CATEGORIES,
  STYLE_RULE_SEVERITIES,
  applyRuleDecisions,
  checkRuleDecisions,
  getRule,
  type StyleRuleCategory,
  type StyleRuleDecision,
  type StyleRuleDecisionIssue,
  type StyleRuleSeverity,
} from '../../../db/shared/style-rules'
import { ROLE } from '../events/role-policy'

// ──────────────────────────────────────────────────────────────────────────
// Command shape
// ──────────────────────────────────────────────────────────────────────────

/** The fields an agent may change with `update`. A subset of the in-app PATCH
 *  body (auth-worker routes/style-rules.ts patchSchema): the rest (scope,
 *  conditions, examples, exceptions, checkSpec) stay in the app. */
export interface StyleRulePatch {
  instruction?: string
  category?: StyleRuleCategory
  severity?: StyleRuleSeverity
  enabled?: boolean
}

export interface StyleRuleDecisionInput {
  ruleId: string
  action: 'approve' | 'reject' | 'update'
  /** The rule's `version` as the caller last read it. */
  ifMatchVersion: number
  /** Required for, and only allowed on, `update`. */
  patch?: StyleRulePatch
}

export interface ReviewStyleRulesCommand {
  kind: 'ReviewStyleRules'
  projectId: string
  decisions: StyleRuleDecisionInput[]
}

export const STYLE_RULE_COMMAND_KINDS = ['ReviewStyleRules'] as const

export function isStyleRuleCommand(c: { kind: string }): c is ReviewStyleRulesCommand {
  return (STYLE_RULE_COMMAND_KINDS as readonly string[]).includes(c.kind)
}

/** Most decisions in one command. 272 proposed rules from one extraction is the
 *  partner case; 500 covers a second pass without letting a single plan hold an
 *  unbounded transaction. Split larger work across changesets. */
export const STYLE_RULE_REVIEW_MAX_DECISIONS = 500

/** The floor for staging, approving and committing: the in-app review floor. */
export const STYLE_RULE_REVIEW_ROLE = ROLE.PROJECT_LEAD

const ACTIONS = ['approve', 'reject', 'update'] as const
const PATCH_KEYS = ['instruction', 'category', 'severity', 'enabled'] as const

// ──────────────────────────────────────────────────────────────────────────
// Validation (shape only; existence, state and versions are checked live)
// ──────────────────────────────────────────────────────────────────────────

export interface StyleRuleValidationIssue {
  index: number
  message: string
}

function validatePatch(
  raw: unknown,
  at: string,
  index: number,
  issues: StyleRuleValidationIssue[],
): StyleRulePatch | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    issues.push({ index, message: `${at}.patch must be an object` })
    return null
  }
  const p = raw as Record<string, unknown>
  const before = issues.length
  for (const key of Object.keys(p)) {
    if (!(PATCH_KEYS as readonly string[]).includes(key)) {
      issues.push({ index, message: `${at}.patch.${key} is not editable here (allowed: ${PATCH_KEYS.join(', ')})` })
    }
  }
  const out: StyleRulePatch = {}
  if (p.instruction !== undefined) {
    if (typeof p.instruction !== 'string' || p.instruction.trim() === '') {
      issues.push({ index, message: `${at}.patch.instruction must be a non-empty string` })
    } else {
      out.instruction = p.instruction
    }
  }
  if (p.category !== undefined) {
    if (!(STYLE_RULE_CATEGORIES as readonly unknown[]).includes(p.category)) {
      issues.push({ index, message: `${at}.patch.category must be one of ${STYLE_RULE_CATEGORIES.join('|')}` })
    } else {
      out.category = p.category as StyleRuleCategory
    }
  }
  if (p.severity !== undefined) {
    if (!(STYLE_RULE_SEVERITIES as readonly unknown[]).includes(p.severity)) {
      issues.push({ index, message: `${at}.patch.severity must be one of ${STYLE_RULE_SEVERITIES.join('|')}` })
    } else {
      out.severity = p.severity as StyleRuleSeverity
    }
  }
  if (p.enabled !== undefined) {
    if (typeof p.enabled !== 'boolean') {
      issues.push({ index, message: `${at}.patch.enabled must be a boolean` })
    } else {
      out.enabled = p.enabled
    }
  }
  if (issues.length > before) return null
  if (Object.keys(out).length === 0) {
    issues.push({ index, message: `${at}.patch contains no editable fields` })
    return null
  }
  return out
}

/** Validate one raw ReviewStyleRules command into its normalized form. */
export function validateStyleRuleCommand(
  c: Record<string, unknown>,
  index: number,
  issues: StyleRuleValidationIssue[],
): ReviewStyleRulesCommand | null {
  const before = issues.length
  if (typeof c.projectId !== 'string' || c.projectId.trim() === '') {
    issues.push({ index, message: 'ReviewStyleRules.projectId must be a non-empty string' })
  }
  if (!Array.isArray(c.decisions) || c.decisions.length === 0) {
    issues.push({ index, message: 'ReviewStyleRules.decisions must be a non-empty array' })
    return null
  }
  if (c.decisions.length > STYLE_RULE_REVIEW_MAX_DECISIONS) {
    issues.push({
      index,
      message: `ReviewStyleRules.decisions has ${c.decisions.length} entries, more than the ${STYLE_RULE_REVIEW_MAX_DECISIONS} maximum; split it across changesets`,
    })
    return null
  }

  const decisions: StyleRuleDecisionInput[] = []
  const seen = new Set<string>()
  c.decisions.forEach((raw: unknown, i: number) => {
    const at = `ReviewStyleRules.decisions[${i}]`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push({ index, message: `${at} must be an object` })
      return
    }
    const d = raw as Record<string, unknown>
    const start = issues.length
    if (typeof d.ruleId !== 'string' || d.ruleId.trim() === '') {
      issues.push({ index, message: `${at}.ruleId must be a non-empty string` })
    } else if (seen.has(d.ruleId)) {
      issues.push({ index, message: `${at}.ruleId ${d.ruleId} appears more than once; one decision per rule` })
    } else {
      seen.add(d.ruleId)
    }
    if (!(ACTIONS as readonly unknown[]).includes(d.action)) {
      issues.push({ index, message: `${at}.action must be one of ${ACTIONS.join('|')}` })
    }
    if (typeof d.ifMatchVersion !== 'number' || !Number.isInteger(d.ifMatchVersion) || d.ifMatchVersion < 0) {
      issues.push({ index, message: `${at}.ifMatchVersion must be a non-negative integer (the rule's version as you read it)` })
    }
    let patch: StyleRulePatch | undefined
    if (d.action === 'update') {
      if (d.patch === undefined) {
        issues.push({ index, message: `${at}.patch is required for update` })
      } else {
        patch = validatePatch(d.patch, at, index, issues) ?? undefined
      }
    } else if (d.patch !== undefined) {
      issues.push({ index, message: `${at}.patch is only allowed on update` })
    }
    if (issues.length > start) return
    decisions.push({
      ruleId: d.ruleId as string,
      action: d.action as StyleRuleDecisionInput['action'],
      ifMatchVersion: d.ifMatchVersion as number,
      ...(patch ? { patch } : {}),
    })
  })
  if (issues.length > before) return null
  return { kind: 'ReviewStyleRules', projectId: c.projectId as string, decisions }
}

// ──────────────────────────────────────────────────────────────────────────
// Refusals
// ──────────────────────────────────────────────────────────────────────────

/** Turn per-decision issues into one error. A stale version is `plan_stale`
 *  (re-read and re-stage); anything else is a `validation_failed` naming each
 *  bad decision. Either way `details.decisions` lists every one. */
function decisionsRefusal(issues: StyleRuleDecisionIssue[], phase: 'prepare' | 'commit'): Response {
  const stale = issues.some((i) => i.code === 'stale_version')
  const message =
    phase === 'prepare'
      ? `${issues.length} decision(s) cannot be applied to the rules as they are now; nothing was staged`
      : `${issues.length} decision(s) no longer hold; nothing was changed`
  return errorResponse(stale ? 'plan_stale' : 'validation_failed', message, { decisions: issues })
}

function toDecisions(cmd: ReviewStyleRulesCommand): StyleRuleDecision[] {
  return cmd.decisions.map((d) => ({
    ruleId: d.ruleId,
    action: d.action,
    ifMatchVersion: d.ifMatchVersion,
    ...(d.patch ? { patch: d.patch } : {}),
  }))
}

// ──────────────────────────────────────────────────────────────────────────
// Prepare
// ──────────────────────────────────────────────────────────────────────────

const PREVIEW_MAX_CHARS = 120

/**
 * Prepare a ReviewStyleRules changeset (sole command): the project must match
 * the changeset's, the caller must hold PROJECT_LEAD, and every decision must
 * already be applicable to the live rows, so a plan that could not commit is
 * refused now instead of after a human approves it. Commit re-checks under a
 * lock.
 */
export async function prepareStyleRuleCommand(
  db: AquillaDb,
  cred: ApiCredentialContext,
  urlProjectId: string,
  id: string,
  autonomyMode: 'ask' | 'act',
  cmd: ReviewStyleRulesCommand,
  env: ExternalEnv,
): Promise<Response> {
  if (cmd.projectId !== urlProjectId) {
    return errorResponse('validation_failed', 'ReviewStyleRules.projectId must match the changeset project')
  }
  const role = await resolveProjectRoleShared(db, { id: cred.userId }, urlProjectId)
  if (!role || role.level < STYLE_RULE_REVIEW_ROLE) {
    return errorResponse('permission_denied', 'insufficient project role for ReviewStyleRules', {
      requiredRole: STYLE_RULE_REVIEW_ROLE,
    })
  }

  const issues = await checkRuleDecisions(db, { projectId: urlProjectId, decisions: toDecisions(cmd) })
  if (issues.length > 0) return decisionsRefusal(issues, 'prepare')

  // What the human on /approve/:id sees: the counts, and each rule's wording.
  const counts = { approve: 0, reject: 0, update: 0 }
  for (const d of cmd.decisions) counts[d.action] += 1
  const texts = new Map<string, string>()
  for (const d of cmd.decisions) {
    const rule = await getRule(db, d.ruleId)
    const full = d.patch?.instruction ?? rule?.instruction ?? ''
    texts.set(d.ruleId, full.length > PREVIEW_MAX_CHARS ? `${full.slice(0, PREVIEW_MAX_CHARS)}…` : full)
  }
  const summary: ChangesetSummary = {
    command: 'ReviewStyleRules',
    projectId: urlProjectId,
    styleRuleReviews: {
      counts,
      items: cmd.decisions.map((d) => ({ ruleId: d.ruleId, action: d.action, instruction: texts.get(d.ruleId) ?? '' })),
    },
    warnings: [],
  }
  const plannedIds: PlannedEventIds = {}

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

// ──────────────────────────────────────────────────────────────────────────
// Commit
// ──────────────────────────────────────────────────────────────────────────

/** The users behind the confirmations this commit would consume, or already
 *  consumed on a crash-retry. Empty in act mode. */
async function confirmerIds(db: AquillaDb, cs: StoredChangeset): Promise<string[]> {
  if (cs.autonomyMode !== 'ask') return []
  const rows =
    cs.status === 'staged'
      ? await db
          .prepare(
            `SELECT user_id FROM changeset_confirmations
              WHERE changeset_id = ? AND credential_id = ? AND digest = ?
                AND consumed_at IS NULL AND expires_at > now()`,
          )
          .bind(cs.id, cs.credentialId, cs.digest)
          .all<{ user_id: string | number | null }>()
      : cs.confirmationId
        ? await db
            .prepare(`SELECT user_id FROM changeset_confirmations WHERE id = ?`)
            .bind(cs.confirmationId)
            .all<{ user_id: string | number | null }>()
        : { results: [] }
  return rows.results.map((r) => r.user_id).filter((u): u is string | number => u != null).map(String)
}

/**
 * Commit a ReviewStyleRules changeset (receipt-only). Re-checks scope and the
 * caller's live role, refuses a confirmation from anyone below PROJECT_LEAD
 * before it is consumed, runs the gates, then applies every decision in one
 * transaction. If any decision no longer holds, nothing is written.
 */
export async function commitStyleRuleCommand(
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  cmd: ReviewStyleRulesCommand,
  channel: ProvenanceChannel,
): Promise<Response> {
  const projectId = cs.projectId
  const wasStaged = cs.status === 'staged'

  // Receipt-only paths mint no internal token, so re-assert the scope ceiling.
  try {
    await assertCredentialScope(db, cred, projectId)
  } catch (err) {
    return toErrorResponse(err)
  }

  const role = await resolveProjectRoleShared(db, { id: cred.userId }, projectId)
  if (!role || role.level < STYLE_RULE_REVIEW_ROLE) {
    return errorResponse('permission_denied', 'insufficient project role for ReviewStyleRules', {
      requiredRole: STYLE_RULE_REVIEW_ROLE,
    })
  }

  // The confirming human must hold the floor too. Checked before the gates so a
  // refusal leaves the confirmation unconsumed and the changeset staged.
  for (const userId of await confirmerIds(db, cs)) {
    const confirmerRole = await resolveProjectRoleShared(db, { id: userId }, projectId)
    if (!confirmerRole || confirmerRole.level < STYLE_RULE_REVIEW_ROLE) {
      return errorResponse(
        'permission_denied',
        'the approval for ReviewStyleRules must come from a project lead or above',
        { requiredRole: STYLE_RULE_REVIEW_ROLE },
      )
    }
  }

  const gate = await receiptOnlyGates(db, cs)
  if (gate instanceof Response) return gate
  const { confirmationId } = gate

  const decisions = toDecisions(cmd)
  const result = await applyRuleDecisions(db, {
    projectId,
    decisions,
    reviewedBy: cred.username,
  })

  if (result.status === 'refused') {
    // A crash-retry re-enters after its own apply. The transaction either
    // committed or did not, so if every rule already sits in the state this
    // plan would leave it in, report that instead of a failure.
    if (!wasStaged) {
      const landed = await alreadyApplied(db, cmd)
      if (landed) {
        return finishReceipt(db, cred, cs, cmd, projectId, landed, confirmationId, channel)
      }
    }
    return decisionsRefusal(result.issues, 'commit')
  }

  return finishReceipt(
    db,
    cred,
    cs,
    cmd,
    projectId,
    result.rules.map((r) => ({ ruleId: r.id, status: r.status, version: r.version })),
    confirmationId,
    channel,
  )
}

/** The rules' current state if each decision's end state already holds. */
async function alreadyApplied(
  db: AquillaDb,
  cmd: ReviewStyleRulesCommand,
): Promise<{ ruleId: string; status: string; version: number }[] | null> {
  const out: { ruleId: string; status: string; version: number }[] = []
  for (const d of cmd.decisions) {
    const rule = await getRule(db, d.ruleId)
    if (!rule) return null
    if (d.action === 'approve' && rule.status !== 'approved') return null
    if (d.action === 'reject' && rule.status !== 'rejected') return null
    if (d.action === 'update') {
      if (rule.version !== d.ifMatchVersion + 1) return null
      const p = d.patch ?? {}
      if (p.instruction !== undefined && rule.instruction !== p.instruction) return null
      if (p.category !== undefined && rule.category !== p.category) return null
      if (p.severity !== undefined && rule.severity !== p.severity) return null
      if (p.enabled !== undefined && rule.enabled !== p.enabled) return null
    }
    out.push({ ruleId: rule.id, status: rule.status, version: rule.version })
  }
  return out
}

async function finishReceipt(
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  cmd: ReviewStyleRulesCommand,
  projectId: string,
  landed: { ruleId: string; status: string; version: number }[],
  confirmationId: string | null,
  channel: ProvenanceChannel,
): Promise<Response> {
  const actionOf = new Map(cmd.decisions.map((d) => [d.ruleId, d.action]))
  const receipt: StyleRuleReviewReceipt = {
    credentialId: cred.credentialId,
    channel,
    changesetId: cs.id,
    command: 'ReviewStyleRules',
    appliedAt: new Date().toISOString(),
    projectId,
    rules: landed.map((r) => ({
      ruleId: r.ruleId,
      action: actionOf.get(r.ruleId) ?? 'update',
      status: r.status,
      version: r.version,
    })),
  }
  await writeCommittedReceipt(db, cs.id, receipt, confirmationId)
  return Response.json({ receipt })
}
