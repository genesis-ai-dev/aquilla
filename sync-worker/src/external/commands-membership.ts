// Membership commands for the Agent API (AQU-1185) — InviteMember, SetRole,
// RemoveMember. Receipt-only like the project-lifecycle commands: they apply a
// plain `project_members` row write, not events.
//
// This is the surface that has burned us twice already (AQU-435 org-wide
// visibility, AQU-780 swallowed 403s) and the one AQU-285 had to close target-
// role holes in. Three rules follow from that history and are enforced at BOTH
// prepare and commit, against the caller's LIVE role each time:
//
//   1. Floor — the credential's effective project role must be >= MAINTAINER.
//      (Stricter than the UI's PROJECT_LEAD floor for add-member: an agent
//      surface gets the higher of the two floors, never the lower.)
//   2. Grant cap — you cannot grant a role above your own level.
//   3. Target cap — below OWNER, you cannot touch a member whose CURRENT role
//      is >= your own, and you can never touch yourself.
//
// Rule 3 is deliberately stricter than the UI's version of the same check. The
// UI compares against the target's DIRECT `project_members.role_level`; here it
// compares against the target's EFFECTIVE (max-wins) role, so an OWNER who
// holds the project through the org or creator path — and therefore has no
// direct row — cannot be removed by a MAINTAINER's agent. On the UI that case
// is merely a no-op delete; on a surface an autonomous agent can drive, a
// no-op that reads as success is how privilege holes get found in production.
//
// Ask-mode by construction: membership is governance, so prepare FORCES the
// staged changeset to ask-mode regardless of the credential's mode. Every
// membership change a machine proposes passes a human at /approve/:id.

import { errorResponse, toErrorResponse } from './errors'
import {
  receiptOnlyGates,
  writeCommittedReceipt,
  markChangesetStale,
  markChangesetSuperseded,
} from './commit-gates'
import { stageAndRespond } from './stage'
import { assertCredentialScope } from './token-bridge'
import { notifyProjectDoMemberRemoved } from '../member-removed'
import { notifyProjectDoMemberRoleChanged } from '../member-role-changed'
import type {
  ChangesetSummary,
  ExternalEnv,
  MembershipReceiptEntry,
  PlannedEventIds,
  ProvenanceChannel,
  ReceiptOnlyReceipt,
  StoredChangeset,
} from './types'
import type { ApiCredentialContext } from '../../../db/shared/api-credentials'
import { resolveProjectRoleShared } from '../../../db/shared/project-roles'
import { ROLE } from '../events/role-policy'

/** Add a person to the project at a role. Fails when they already hold a direct
 *  membership row — re-roling an existing member is `SetRole`, so an "invite"
 *  can never silently demote somebody. */
export interface InviteMemberCommand {
  kind: 'InviteMember'
  projectId: string
  username: string
  role: number
}

/** Change an existing direct member's role. Fails when there is no direct row —
 *  granting access to a new person is `InviteMember`. */
export interface SetRoleCommand {
  kind: 'SetRole'
  projectId: string
  username: string
  role: number
}

/** Drop a member's direct `project_members` row. Org / group / creator grant
 *  paths are additive and unaffected (AD-12) — this removes the direct grant
 *  only, exactly like the UI's DELETE /members/:userId. */
export interface RemoveMemberCommand {
  kind: 'RemoveMember'
  projectId: string
  username: string
}

export type MembershipCommand = InviteMemberCommand | SetRoleCommand | RemoveMemberCommand

/** The role floor a credential must hold to stage or commit ANY membership
 *  command (acceptance criterion: "effective role must be >= MAINTAINER"). */
export const MEMBERSHIP_FLOOR = ROLE.MAINTAINER

/** Max membership commands in one changeset. A batch is one approval, so it is
 *  capped low enough that a human can actually read every line on /approve. */
export const MEMBERSHIP_MAX_COMMANDS = 25

/** The canonical role ladder (role-policy.ts). A level off the ladder is a
 *  caller bug, not a value to clamp — clamping would silently grant a role
 *  nobody asked for. */
const CANONICAL_ROLE_LEVELS: readonly number[] = [
  ROLE.VIEWER,
  ROLE.COMMENTER,
  ROLE.REVIEWER,
  ROLE.CONTRIBUTOR,
  ROLE.PROJECT_LEAD,
  ROLE.MAINTAINER,
  ROLE.OWNER,
]

const ROLE_NAMES: Record<number, string> = {
  [ROLE.VIEWER]: 'viewer',
  [ROLE.COMMENTER]: 'commenter',
  [ROLE.REVIEWER]: 'reviewer',
  [ROLE.CONTRIBUTOR]: 'contributor',
  [ROLE.PROJECT_LEAD]: 'project_lead',
  [ROLE.MAINTAINER]: 'maintainer',
  [ROLE.OWNER]: 'owner',
}

/** Human-readable role name for the approval page and error messages. */
export function roleName(level: number): string {
  return ROLE_NAMES[level] ?? `level_${level}`
}

export interface MembershipValidationIssue {
  index: number
  message: string
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/** True for the three membership kinds — used by the prepare/commit dispatch. */
export function isMembershipCommand(c: { kind: string }): boolean {
  return c.kind === 'InviteMember' || c.kind === 'SetRole' || c.kind === 'RemoveMember'
}

/**
 * Validate one raw membership command (shape only — every authorization check
 * is a live prepare/commit concern, never a parse-time one).
 */
export function validateMembershipCommand(
  c: Record<string, unknown>,
  index: number,
  issues: MembershipValidationIssue[],
): MembershipCommand | null {
  const kind = c.kind as MembershipCommand['kind']
  if (!isNonEmptyString(c.projectId)) {
    issues.push({ index, message: `${kind}.projectId must be a non-empty string` })
    return null
  }
  if (!isNonEmptyString(c.username) || c.username.length > 128) {
    issues.push({ index, message: `${kind}.username must be a non-empty string (max 128 chars)` })
    return null
  }
  if (kind === 'RemoveMember') {
    return { kind, projectId: c.projectId, username: c.username }
  }
  if (typeof c.role !== 'number' || !CANONICAL_ROLE_LEVELS.includes(c.role)) {
    issues.push({
      index,
      message: `${kind}.role must be one of ${CANONICAL_ROLE_LEVELS.join(', ')}`,
    })
    return null
  }
  return { kind, projectId: c.projectId, username: c.username, role: c.role }
}

/** One plain-language line per command for the /approve page. */
export function describeChange(cmd: MembershipCommand): string {
  if (cmd.kind === 'InviteMember') {
    return `Add ${cmd.username} to ${cmd.projectId} as ${roleName(cmd.role)} (${cmd.role})`
  }
  if (cmd.kind === 'SetRole') {
    return `Change ${cmd.username}'s role in ${cmd.projectId} to ${roleName(cmd.role)} (${cmd.role})`
  }
  return `Remove ${cmd.username} from ${cmd.projectId}`
}

export interface TargetUser {
  id: string
  username: string
}

/** Look the target up by username, case-insensitively (mirrors auth-worker's
 *  lookupUserByUsername, which the members UI uses). */
export async function lookupUser(db: AquillaDb, username: string): Promise<TargetUser | null> {
  const row = await db
    .prepare(`SELECT id::text AS id, username FROM users WHERE lower(username) = lower(?)`)
    .bind(username)
    .first<{ id: string; username: string }>()
  return row ? { id: row.id, username: row.username } : null
}

/** The target's DIRECT project_members role level, or null when they hold no
 *  direct row (they may still have access via org / group / creator). */
export async function directRoleLevel(
  db: AquillaDb,
  projectId: string,
  userId: string,
): Promise<number | null> {
  const row = await db
    .prepare(`SELECT role_level FROM project_members WHERE project_id = ? AND user_id = ?`)
    .bind(projectId, userId)
    .first<{ role_level: number }>()
  return row ? Number(row.role_level) : null
}

/** The target's EFFECTIVE (max-wins) role level across every grant path, or 0
 *  for a non-member. This is what the target cap compares against. */
async function effectiveRoleLevel(
  db: AquillaDb,
  projectId: string,
  userId: string,
): Promise<number> {
  const resolved = await resolveProjectRoleShared(db, { id: userId }, projectId)
  return resolved?.level ?? 0
}

/** A gate outcome: the resolved target, or the denial to return verbatim. */
export type GateResult =
  | { ok: true; target: TargetUser; directLevel: number | null }
  | { ok: false; response: Response }

/**
 * The full authorization gate for ONE membership command, evaluated live.
 * Identical at prepare and at commit — a plan is never trusted to have been
 * checked already, because the caller's role, the target's role, and the
 * membership rows can all move in the hour a changeset stays staged.
 */
export async function gateOne(
  db: AquillaDb,
  cred: ApiCredentialContext,
  callerLevel: number,
  cmd: MembershipCommand,
): Promise<GateResult> {
  const projectId = cmd.projectId

  // Grant cap: never hand out a role above your own. Checked before the user
  // lookup so an over-privileged ask is refused without confirming whether the
  // named account exists.
  if (cmd.kind !== 'RemoveMember' && cmd.role > callerLevel) {
    return {
      ok: false,
      response: errorResponse(
        'permission_denied',
        `cannot grant role ${cmd.role} (${roleName(cmd.role)}) — your role is ${callerLevel} (${roleName(callerLevel)})`,
        { code: 'role_above_caller', username: cmd.username, requestedRole: cmd.role, callerRole: callerLevel },
      ),
    }
  }

  const target = await lookupUser(db, cmd.username)
  if (!target) {
    return {
      ok: false,
      response: errorResponse('not_found', `user ${cmd.username} not found`, {
        code: 'user_not_found',
        username: cmd.username,
      }),
    }
  }

  // Self-target: covers self-elevation (SetRole on yourself) and the
  // last-owner lock-out (RemoveMember on yourself). Never allowed, at any role.
  if (String(target.id) === String(cred.userId)) {
    return {
      ok: false,
      response: errorResponse('permission_denied', 'cannot change your own membership', {
        code: 'self_target',
        username: cmd.username,
      }),
    }
  }

  const directLevel = await directRoleLevel(db, projectId, target.id)

  // Target cap (AQU-285 F-B6, widened to the effective role — see file header).
  if (callerLevel < ROLE.OWNER) {
    const targetLevel = Math.max(directLevel ?? 0, await effectiveRoleLevel(db, projectId, target.id))
    if (targetLevel >= callerLevel) {
      return {
        ok: false,
        response: errorResponse(
          'permission_denied',
          `cannot modify ${cmd.username}: their role (${targetLevel}) is >= your role (${callerLevel})`,
          { code: 'target_outranks_caller', username: cmd.username, targetRole: targetLevel, callerRole: callerLevel },
        ),
      }
    }
  }

  return { ok: true, target, directLevel }
}

/** Resolve the caller's live role and enforce the MAINTAINER floor. */
export async function callerLevelOrDenial(
  db: AquillaDb,
  cred: ApiCredentialContext,
  projectId: string,
): Promise<number | Response> {
  const role = await resolveProjectRoleShared(db, { id: cred.userId }, projectId)
  if (!role || role.level < MEMBERSHIP_FLOOR) {
    return errorResponse(
      'permission_denied',
      'project role >= maintainer required to manage membership',
      { requiredRole: MEMBERSHIP_FLOOR },
    )
  }
  return role.level
}

/**
 * Prepare a membership changeset. Every command must target the changeset's own
 * project, name a distinct person, and pass the full gate below the caller's
 * live role. Target user ids are pinned into the plan so a commit an hour later
 * writes the person who was approved, not whoever holds that username by then.
 */
export async function prepareMembership(
  db: AquillaDb,
  cred: ApiCredentialContext,
  urlProjectId: string,
  id: string,
  cmds: MembershipCommand[],
  env: ExternalEnv,
): Promise<Response> {
  if (cmds.length > MEMBERSHIP_MAX_COMMANDS) {
    return errorResponse(
      'validation_failed',
      `at most ${MEMBERSHIP_MAX_COMMANDS} membership commands per changeset`,
    )
  }
  for (const cmd of cmds) {
    if (cmd.projectId !== urlProjectId) {
      return errorResponse(
        'validation_failed',
        `${cmd.kind}.projectId must match the changeset project`,
      )
    }
  }

  // Two commands on the same person in one plan have no defined order and the
  // approval page could not honestly describe the outcome — reject, don't merge.
  const seen = new Set<string>()
  for (const cmd of cmds) {
    const key = cmd.username.toLowerCase()
    if (seen.has(key)) {
      return errorResponse(
        'validation_failed',
        `${cmd.username} appears in more than one membership command`,
      )
    }
    seen.add(key)
  }

  const callerLevel = await callerLevelOrDenial(db, cred, urlProjectId)
  if (callerLevel instanceof Response) return callerLevel

  const pinned: { username: string; userId: string }[] = []
  for (const cmd of cmds) {
    const gate = await gateOne(db, cred, callerLevel, cmd)
    if (!gate.ok) return gate.response

    // State preconditions — each command states unambiguously what it does, so
    // an "invite" can never demote and a "set role" can never grant new access.
    if (cmd.kind === 'InviteMember' && gate.directLevel !== null) {
      return errorResponse(
        'conflict',
        `${cmd.username} already has a direct membership (${gate.directLevel}) — use SetRole to change it`,
        { code: 'already_member', username: cmd.username },
      )
    }
    if (cmd.kind !== 'InviteMember' && gate.directLevel === null) {
      return errorResponse(
        'conflict',
        `${cmd.username} has no direct membership in this project` +
          (cmd.kind === 'SetRole' ? ' — use InviteMember to grant one' : ''),
        { code: 'not_a_direct_member', username: cmd.username },
      )
    }

    pinned.push({ username: gate.target.username, userId: gate.target.id })
  }

  const plannedIds: PlannedEventIds = { membership: pinned }
  const summary: ChangesetSummary = {
    command: 'Membership',
    projectId: urlProjectId,
    membershipChanges: cmds.map(describeChange),
    warnings: [],
  }

  // Governance: FORCED ask-mode regardless of the credential's mode, exactly
  // like CreateProject. An act token cannot re-role a project's staff.
  return stageAndRespond(db, env, {
    id,
    projectId: urlProjectId,
    createdByUserId: String(cred.userId),
    credentialId: cred.credentialId,
    autonomyMode: 'ask',
    commands: cmds,
    preconditions: [],
    summary,
    plannedIds,
  })
}

/** Live state of one pinned target at commit time. */
export interface CommitTarget {
  cmd: MembershipCommand
  userId: string
  username: string
  directLevel: number | null
}

/**
 * Commit a membership changeset (receipt-only). Re-runs every prepare-time gate
 * against the LIVE role graph, then classifies drift before touching a row:
 * a plan whose end-state a human already applied by hand is `superseded`
 * (healthy), a plan whose world moved some other way is `stale`. The batch is
 * all-or-nothing — a governance approval covers the set the human read, so a
 * partial apply is never the right answer.
 */
export async function commitMembership(
  db: AquillaDb,
  env: ExternalEnv,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  cmds: MembershipCommand[],
  channel: ProvenanceChannel,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response> {
  const projectId = cs.projectId

  // Receipt-only paths mint no internal token, so re-assert the scope ceiling.
  try {
    await assertCredentialScope(db, cred, projectId)
  } catch (err) {
    return toErrorResponse(err)
  }

  const callerLevel = await callerLevelOrDenial(db, cred, projectId)
  if (callerLevel instanceof Response) return callerLevel

  const pinnedIds = cs.plannedIds?.membership ?? []
  const targets: CommitTarget[] = []
  let superseded = 0

  for (const [index, cmd] of cmds.entries()) {
    const gate = await gateOne(db, cred, callerLevel, cmd)
    if (!gate.ok) return gate.response

    // The pinned id wins over the freshly resolved one: the human approved a
    // person, not a string. A username that now resolves elsewhere is drift.
    const pinned = pinnedIds[index]
    if (pinned && String(pinned.userId) !== String(gate.target.id)) {
      await markChangesetStale(db, cs.id)
      return errorResponse(
        'plan_stale',
        `${cmd.username} no longer resolves to the account this plan was approved for`,
        { status: 'stale', username: cmd.username },
      )
    }

    const directLevel = gate.directLevel
    if (cmd.kind === 'InviteMember') {
      // Already at the proposed role → a human did it. Anything else present is
      // a different membership than the one approved.
      if (directLevel === cmd.role) superseded += 1
      else if (directLevel !== null) {
        await markChangesetStale(db, cs.id)
        return errorResponse('plan_stale', `${cmd.username} gained a different direct role (${directLevel}) since prepare`, {
          status: 'stale',
          username: cmd.username,
        })
      }
    } else if (cmd.kind === 'SetRole') {
      if (directLevel === null) {
        await markChangesetStale(db, cs.id)
        return errorResponse('plan_stale', `${cmd.username}'s direct membership was removed since prepare`, {
          status: 'stale',
          username: cmd.username,
        })
      }
      if (directLevel === cmd.role) superseded += 1
    } else if (directLevel === null) {
      superseded += 1
    }

    targets.push({
      cmd,
      userId: gate.target.id,
      username: gate.target.username,
      directLevel,
    })
  }

  // Every command's end-state already exists — the humans got there first.
  if (superseded === cmds.length) {
    await markChangesetSuperseded(db, cs.id)
    return errorResponse(
      'plan_stale',
      'plan already satisfied — the proposed membership already matches',
      { status: 'superseded' },
    )
  }

  const gate = await receiptOnlyGates(db, cs)
  if (gate instanceof Response) return gate

  const applied = await applyMembershipRows(db, env, cred, projectId, targets, ctx)

  const receipt: ReceiptOnlyReceipt = {
    credentialId: cred.credentialId,
    channel,
    changesetId: cs.id,
    command: 'Membership',
    appliedAt: new Date().toISOString(),
    projectId,
    membership: applied,
  }
  await writeCommittedReceipt(db, cs.id, receipt, gate.confirmationId)
  return Response.json({ receipt })
}

/**
 * Write the `project_members` rows for a gated batch and report what changed.
 *
 * Extracted (AQU-1294) so the ProjectSetup composite command's members step
 * applies membership through the SAME rows, the same upsert, and the same DO
 * notifications as a Membership changeset. Assumes every target has already
 * passed `gateOne` against the caller's LIVE role — it authorizes nothing.
 */
export async function applyMembershipRows(
  db: AquillaDb,
  env: ExternalEnv,
  cred: ApiCredentialContext,
  projectId: string,
  targets: readonly CommitTarget[],
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): Promise<MembershipReceiptEntry[]> {
  const applied: MembershipReceiptEntry[] = []
  for (const target of targets) {
    const { cmd, userId, username, directLevel } = target
    if (cmd.kind === 'RemoveMember') {
      if (directLevel !== null) {
        await db
          .prepare(`DELETE FROM project_members WHERE project_id = ? AND user_id = ?`)
          .bind(projectId, userId)
          .run()
      }
      applied.push({ kind: cmd.kind, userId, username, previousRole: directLevel })
      notifyRemovalBestEffort(env, projectId, userId, username, ctx)
      continue
    }
    await db
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role_level, granted_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, user_id) DO UPDATE SET
           role_level = excluded.role_level,
           granted_by = excluded.granted_by,
           granted_at = CURRENT_TIMESTAMP`,
      )
      .bind(projectId, userId, cmd.role, cred.userId)
      .run()
    applied.push({ kind: cmd.kind, userId, username, role: cmd.role, previousRole: directLevel })
    notifyRoleChangeBestEffort(env, projectId, userId, username, cmd.role, ctx)
  }
  return applied
}

/** Detach a DO notify so a live socket picks the change up immediately. Never
 *  allowed to fail or delay the commit — the hard guarantees are the sync-token
 *  re-resolution and the POST /events membership re-check, exactly as on the
 *  identity-side routes this mirrors. */
function detach(promise: Promise<unknown>, ctx?: Pick<ExecutionContext, 'waitUntil'>): void {
  const swallowed = promise.catch((err) => {
    console.warn('[membership] DO notify failed (non-fatal):', err)
  })
  if (ctx) ctx.waitUntil(swallowed)
  else void swallowed
}

function notifyRemovalBestEffort(
  env: ExternalEnv,
  projectId: string,
  userId: string,
  username: string,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): void {
  if (!env.ProjectSync) return
  detach(notifyProjectDoMemberRemoved(env, projectId, { userId: Number(userId), username }), ctx)
}

function notifyRoleChangeBestEffort(
  env: ExternalEnv,
  projectId: string,
  userId: string,
  username: string,
  role: number,
  ctx?: Pick<ExecutionContext, 'waitUntil'>,
): void {
  if (!env.ProjectSync) return
  detach(
    notifyProjectDoMemberRoleChanged(env, projectId, { userId: Number(userId), username, role }),
    ctx,
  )
}
