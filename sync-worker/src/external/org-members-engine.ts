// Gate / prepare / commit engine for the AQU-1235 org-membership commands.
//
// The command shapes and their payload validation live in
// commands-org-members.ts, which is deliberately dependency-free (auth-worker
// imports it). Everything that touches the database or the changeset store
// lives here, mirroring the commands-emit-events.ts / emit-events-engine.ts
// split.
//
// Every gate is re-run at COMMIT as well as at prepare (the D8 live-role
// doctrine): an owner whose ownership lapses after staging is denied at the
// commit, not at the row write.

import { errorResponse } from './errors'
import { stageAndRespond } from './stage'
import { receiptOnlyGates } from './commit-gates'
import { orgRoleName, type OrgMemberCommand } from './commands-org-members'
import { ROLE } from '../events/role-policy'
import type { ApiCredentialContext } from '../../../db/shared/api-credentials'
import type {
  ChangesetSummary,
  ExternalEnv,
  PlannedEventIds,
  ProvenanceChannel,
  ReceiptOnlyReceipt,
  StoredChangeset,
} from './types'
// ── shared gate ──────────────────────────────────────────────────────────────

interface OrgMemberGate {
  orgId: number
  orgName: string | null
  /** organizations.owner_user_id — the row-level owner, never removable. */
  orgOwnerUserId: string
  targetUserId: string
  targetUsername: string
  /** The target's CURRENT org role level, or null when not a member. */
  currentLevel: number | null
  /** The caller's CURRENT org role level (>= OWNER by the time this returns). */
  callerLevel: number
}

/**
 * The whole gate sequence for an org-membership command, run identically at
 * prepare and at commit (D8 live-role doctrine — never trust a role resolved
 * earlier). Returns the resolved facts, or the denial Response.
 */
async function resolveOrgMemberGate(
  db: AquillaDb,
  cred: ApiCredentialContext,
  cmd: OrgMemberCommand,
): Promise<OrgMemberGate | Response> {
  // Scope: a project-scoped credential can never reach org governance. (Act
  // tokens are project-scoped at mint, which is the second reason these
  // commands are ask-mode-only by construction.)
  if (cred.projectId != null) {
    return errorResponse('scope_denied', 'a project-scoped credential cannot manage org membership')
  }

  const orgId = typeof cmd.orgId === 'number' ? cmd.orgId : Number(cmd.orgId)
  if (!Number.isInteger(orgId)) {
    return errorResponse('validation_failed', `${cmd.kind}.orgId must be an integer org id`)
  }
  if (cred.orgId != null && cred.orgId !== String(orgId)) {
    return errorResponse('scope_denied', 'credential org scope does not match the target org')
  }

  const org = await db
    .prepare(`SELECT id, name, owner_user_id FROM organizations WHERE id = ?`)
    .bind(orgId)
    .first<{ id: number; name: string | null; owner_user_id: number | string }>()
  if (!org) {
    return errorResponse('not_found', `org ${orgId} not found`)
  }

  // OWNER-only (AQU-780). Platform-admin elevation is deliberately NOT applied:
  // the external API confers no cross-tenant governance authority.
  const callerRow = await db
    .prepare(`SELECT role_level FROM org_members WHERE org_id = ? AND user_id = ?`)
    .bind(orgId, cred.userId)
    .first<{ role_level: number }>()
  const callerLevel = callerRow?.role_level ?? null
  if (callerLevel == null || callerLevel < ROLE.OWNER) {
    return errorResponse('permission_denied', 'org role owner is required to manage org membership')
  }

  const target = await resolveUsername(db, cmd.username)
  if (!target) {
    return errorResponse('validation_failed', `no user named "${cmd.username}"`)
  }
  if (String(target.id) === String(cred.userId)) {
    return errorResponse('validation_failed', 'cannot change your own org membership')
  }

  // Target-role cap (AQU-285): never hand out more than you hold.
  if (cmd.kind !== 'RemoveOrgMember' && cmd.role > callerLevel) {
    return errorResponse(
      'permission_denied',
      'cannot grant an org role above your own',
      { requestedRole: cmd.role, callerRole: callerLevel },
    )
  }

  const currentRow = await db
    .prepare(`SELECT role_level FROM org_members WHERE org_id = ? AND user_id = ?`)
    .bind(orgId, target.id)
    .first<{ role_level: number }>()
  const currentLevel = currentRow?.role_level ?? null

  if (cmd.kind === 'AddOrgMember' && currentLevel != null) {
    return errorResponse(
      'validation_failed',
      `${target.username} is already a member of this org — use SetOrgRole to change their role`,
      { currentRole: currentLevel },
    )
  }
  if (cmd.kind !== 'AddOrgMember' && currentLevel == null) {
    return errorResponse('validation_failed', `${target.username} is not a member of this org`)
  }

  // Last-OWNER guard (AQU-285), two layers:
  //
  //  • organizations.owner_user_id is never demotable or removable through this
  //    surface. This is the layer that actually fires — with the caller required
  //    to be an owner and forbidden from targeting themselves, "one owner tries
  //    to unseat another" is the only reachable owner-vs-owner shape.
  //  • The owner-count check below is defence in depth. Under today's OWNER-only
  //    gate it cannot trigger (the caller is themselves a surviving owner), but
  //    it is what keeps the invariant true if that floor is ever lowered.
  const demoting = cmd.kind === 'SetOrgRole' && cmd.role < ROLE.OWNER
  const losingOwner = cmd.kind === 'RemoveOrgMember' || demoting
  if (losingOwner && (currentLevel ?? 0) >= ROLE.OWNER) {
    if (String(org.owner_user_id) === String(target.id)) {
      return errorResponse('permission_denied', "the organization's owner cannot be demoted or removed")
    }
    const others = await db
      .prepare(
        `SELECT COUNT(*)::int AS n FROM org_members
          WHERE org_id = ? AND user_id <> ? AND role_level >= ?`,
      )
      .bind(orgId, target.id, ROLE.OWNER)
      .first<{ n: number }>()
    if ((others?.n ?? 0) === 0) {
      return errorResponse('permission_denied', 'cannot demote or remove the last owner of an org')
    }
  }

  return {
    orgId,
    orgName: org.name ?? null,
    orgOwnerUserId: String(org.owner_user_id),
    targetUserId: String(target.id),
    targetUsername: target.username,
    currentLevel,
    callerLevel,
  }
}

/** Username → user, trimmed exact-match first then an UNAMBIGUOUS
 *  case-insensitive fallback. Mirrors auth-worker's lookupUserByUsername
 *  (AQU-457): a two-row ceiling makes the lookup fail closed if the
 *  UNIQUE(LOWER(username)) invariant is ever violated. */
async function resolveUsername(
  db: AquillaDb,
  username: string,
): Promise<{ id: number | string; username: string } | null> {
  const trimmed = username.trim()
  if (!trimmed) return null
  const exact = await db
    .prepare(`SELECT id, username FROM users WHERE username = ? LIMIT 1`)
    .bind(trimmed)
    .first<{ id: number | string; username: string }>()
  if (exact) return exact
  const ci = await db
    .prepare(`SELECT id, username FROM users WHERE LOWER(username) = LOWER(?) ORDER BY id ASC LIMIT 2`)
    .bind(trimmed)
    .all<{ id: number | string; username: string }>()
  const rows = ci.results ?? []
  return rows.length === 1 ? rows[0] : null
}

// ── prepare ──────────────────────────────────────────────────────────────────

/**
 * Stage an org-membership changeset. The plan pins the resolved target user id
 * and the target's role level AT PREPARE, so commit can tell "nothing moved"
 * from "someone else changed this member since the plan was made"
 * (plan_stale) — the versioned-blob equivalent of a per-cell head pin.
 */
export async function prepareOrgMember(
  db: AquillaDb,
  cred: ApiCredentialContext,
  urlProjectId: string,
  id: string,
  cmd: OrgMemberCommand,
  env: ExternalEnv,
): Promise<Response> {
  const gate = await resolveOrgMemberGate(db, cred, cmd)
  if (gate instanceof Response) return gate

  const plannedIds: PlannedEventIds = {
    orgMember: {
      orgId: gate.orgId,
      targetUserId: gate.targetUserId,
      previousRole: gate.currentLevel,
      ...(cmd.kind !== 'RemoveOrgMember' ? { role: cmd.role } : {}),
    },
  }

  // The effect summary the /approve page renders in plain language: who, which
  // org, what role, and what they hold today. Every value is server-resolved —
  // the agent supplied a username, not an identity.
  const summary: ChangesetSummary = {
    command: cmd.kind,
    orgMemberUsername: gate.targetUsername,
    targetOrg: gate.orgName ? `${gate.orgName} (id ${gate.orgId})` : String(gate.orgId),
    ...(cmd.kind === 'RemoveOrgMember'
      ? {}
      : { orgMemberNewRole: orgRoleName(cmd.role) }),
    orgMemberCurrentRole: gate.currentLevel == null ? 'not a member' : orgRoleName(gate.currentLevel),
    warnings: [],
  }

  // Ask-mode by construction (see the module header) — `autonomyMode` from the
  // credential or the request is intentionally not consulted.
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

// ── commit ───────────────────────────────────────────────────────────────────

/**
 * Apply an org-membership changeset. Re-runs the FULL gate live (a caller whose
 * ownership lapsed between prepare and commit is denied here, not at the row
 * write), re-checks the pinned previous role, then applies the row write and
 * writes the receipt-only receipt carrying the credential id.
 *
 * Crash-retry (status 'committing'): the pinned previous role no longer matches
 * because OUR OWN prior attempt already applied it. That case is recognised and
 * absorbed idempotently instead of being reported as drift.
 */
export async function commitOrgMember(
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  cmd: OrgMemberCommand,
  channel: ProvenanceChannel,
): Promise<Response> {
  const wasStaged = cs.status === 'staged'
  const planned = cs.plannedIds?.orgMember ?? null

  const gate = await resolveOrgMemberGate(db, cred, cmd)
  if (gate instanceof Response) {
    // On a retry the gate legitimately refuses the ALREADY-APPLIED command
    // (AddOrgMember: "already a member"; RemoveOrgMember: "not a member"), so
    // absorb that one shape as idempotent success rather than an error.
    if (!wasStaged && planned && (await alreadyApplied(db, cmd, planned))) {
      return Response.json({ receipt: await writeOrgMemberReceipt(db, cred, cs, cmd, planned, channel) })
    }
    return gate
  }

  // Identity drift: the human approved a change to a specific PERSON, and the
  // plan pinned their user id. If the username now resolves to somebody else
  // (a rename, an account recycled), the approval does not cover this write.
  if (planned && gate.targetUserId !== planned.targetUserId) {
    return errorResponse('plan_stale', 'the username now resolves to a different user', {
      expected: planned.targetUserId,
      current: gate.targetUserId,
    })
  }

  // Drift: the member's role moved since prepare. Absorbed on a retry when the
  // live value is exactly what we were going to write.
  if (planned && gate.currentLevel !== planned.previousRole) {
    const ourOwnWrite =
      !wasStaged && planned.role !== undefined && gate.currentLevel === planned.role
    if (!ourOwnWrite) {
      return errorResponse('plan_stale', "the member's org role changed since prepare", {
        expected: planned.previousRole,
        current: gate.currentLevel,
      })
    }
  }

  const guarded = await receiptOnlyGates(db, cs)
  if (guarded instanceof Response) return guarded
  const confirmationId = guarded.confirmationId

  if (cmd.kind === 'RemoveOrgMember') {
    // Cascade out of the org's groups too — the roster UI's DELETE does the
    // same, so a removed member does not keep group-derived project access.
    await db.batch([
      db.prepare(`DELETE FROM org_members WHERE org_id = ? AND user_id = ?`)
        .bind(gate.orgId, gate.targetUserId),
      db.prepare(
        `DELETE FROM group_members WHERE user_id = ? AND group_id IN (SELECT id FROM groups WHERE org_id = ?)`,
      ).bind(gate.targetUserId, gate.orgId),
    ])
  } else {
    // granted_by is the audit stamp on the row itself; the credential id lives
    // in the receipt below.
    await db
      .prepare(
        `INSERT INTO org_members (org_id, user_id, role_level, granted_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(org_id, user_id) DO UPDATE SET
           role_level = excluded.role_level,
           granted_by = excluded.granted_by,
           granted_at = CURRENT_TIMESTAMP`,
      )
      .bind(gate.orgId, gate.targetUserId, cmd.role, cred.userId)
      .run()
  }

  const receipt = await writeOrgMemberReceipt(
    db,
    cred,
    cs,
    cmd,
    { orgId: gate.orgId, targetUserId: gate.targetUserId, previousRole: gate.currentLevel, ...(cmd.kind !== 'RemoveOrgMember' ? { role: cmd.role } : {}) },
    channel,
    confirmationId,
  )
  return Response.json({ receipt })
}

/** True when the live rows already show this command's end state — the only
 *  reason a crash-retry may skip re-applying. */
async function alreadyApplied(
  db: AquillaDb,
  cmd: OrgMemberCommand,
  planned: NonNullable<PlannedEventIds['orgMember']>,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT role_level FROM org_members WHERE org_id = ? AND user_id = ?`)
    .bind(planned.orgId, planned.targetUserId)
    .first<{ role_level: number }>()
  if (cmd.kind === 'RemoveOrgMember') return row == null
  return row != null && row.role_level === planned.role
}

/** Terminal committed write for an org-membership plan. The receipt is the
 *  audit record: it names the credential, the channel, the org, the target, and
 *  the role transition. */
async function writeOrgMemberReceipt(
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  cmd: OrgMemberCommand,
  planned: NonNullable<PlannedEventIds['orgMember']>,
  channel: ProvenanceChannel,
  confirmationId: string | null = cs.confirmationId ?? null,
): Promise<ReceiptOnlyReceipt> {
  const receipt: ReceiptOnlyReceipt = {
    credentialId: cred.credentialId,
    channel,
    changesetId: cs.id,
    command: cmd.kind,
    appliedAt: new Date().toISOString(),
    projectId: cs.projectId,
    orgId: planned.orgId,
    targetUserId: planned.targetUserId,
    ...(planned.previousRole != null ? { previousRole: planned.previousRole } : {}),
    ...(planned.role !== undefined ? { role: planned.role } : {}),
  }
  await db
    .prepare(
      `UPDATE changesets
          SET status = 'committed', receipt = ?::text::jsonb, confirmation_id = ?, committed_at = now()
        WHERE id = ?`,
    )
    .bind(JSON.stringify(receipt), confirmationId, cs.id)
    .run()
  return receipt
}
