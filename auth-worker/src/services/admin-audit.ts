// Audit trail for membership changes made by a platform admin (AQU-1322).
//
// Platform admins can change org, team and project membership, and mint or
// revoke invites, on tenants they do not belong to (support work). Those changes go through the ordinary member
// routes, so nothing marked them as admin actions. This helper writes one
// `admin_audit_log` row per change, but only when the ACTING user is a platform
// admin; every other caller gets a no-op, so their requests behave as before.
//
// Actions (dotted, like 'elevation.grant' and 'settings.update'):
//   org.member.add | org.member.role | org.member.remove
//   project.member.grant | project.member.role | project.member.remove
//   project.member.revoke_all
//   team.create | team.update | team.delete
//   team.member.add | team.member.remove | team.member.role
//   team.project.attach | team.project.role | team.project.detach
//   org.invite.create | org.invite.revoke
//   project.invite.create | project.invite.revoke
//   project.access_link.create | project.access_link.revoke
//
// Invites have no user target: the row records the invite's role and email,
// never its token. Access links target the bound user and never log the token
// or pin.
//
// The row is best-effort: it is written after the membership change has
// committed, and a failed insert is logged, not thrown, because a 500 at that
// point would tell the admin the change failed when it did not (and, in a
// batch, would skip the remaining people). Same choice as admin-billing.ts.

import type { AuthUser, Env } from "../types"
import { isPlatformAdminEmail } from "../middleware/platform-admin"

export type MembershipAuditAction =
  | "org.member.add"
  | "org.member.role"
  | "org.member.remove"
  | "project.member.grant"
  | "project.member.role"
  | "project.member.remove"
  | "project.member.revoke_all"
  | "team.create"
  | "team.update"
  | "team.delete"
  | "team.member.add"
  | "team.member.remove"
  | "team.member.role"
  | "team.project.attach"
  | "team.project.role"
  | "team.project.detach"
  | "org.invite.create"
  | "org.invite.revoke"
  | "project.invite.create"
  | "project.invite.revoke"
  | "project.access_link.create"
  | "project.access_link.revoke"

type MembershipScope =
  | { scope: "org"; orgId: number }
  | { scope: "team"; orgId: number; groupId: number }
  | { scope: "project"; projectId: string }

type ActingUser = Pick<AuthUser, "id" | "username" | "email">

export const isAdminActor = (env: Env, actor: ActingUser): boolean =>
  isPlatformAdminEmail(env, actor.email)

/**
 * The target's role in this org/project before the change, or null when they
 * have no direct row. Queries only for platform admins so other callers pay
 * nothing for the audit.
 */
export async function priorMembershipRole(
  env: Env,
  actor: ActingUser,
  where: Extract<MembershipScope, { scope: "org" | "project" }>,
  targetUserId: number,
): Promise<number | null> {
  if (!isAdminActor(env, actor)) return null
  const row =
    where.scope === "org"
      ? await env.AQUILLA_PG.prepare(
          "SELECT role_level FROM org_members WHERE org_id = ? AND user_id = ?",
        )
          .bind(where.orgId, targetUserId)
          .first<{ role_level: number }>()
      : await env.AQUILLA_PG.prepare(
          "SELECT role_level FROM project_members WHERE project_id = ? AND user_id = ?",
        )
          .bind(where.projectId, targetUserId)
          .first<{ role_level: number }>()
  return row ? Number(row.role_level) : null
}

export async function auditMembershipChange(
  env: Env,
  actor: ActingUser,
  entry: {
    action: MembershipAuditAction
    where: MembershipScope
    /** Omitted for changes with no user target (team and invite changes). */
    target?: { id: number; username?: string } | null
    roleBefore: number | null
    roleAfter: number | null
    /** The project a team.project.* change touches (the scope is the team). */
    projectId?: string
    /** The invitee's email on an invite change, when the invite has one. */
    email?: string | null
  },
): Promise<void> {
  if (!isAdminActor(env, actor)) return
  try {
    const target = entry.target ?? null
    const targetUsername = target
      ? (target.username ??
        (
          await env.AQUILLA_PG.prepare("SELECT username FROM users WHERE id = ?")
            .bind(target.id)
            .first<{ username: string }>()
        )?.username ??
        null)
      : null
    const detail = {
      action: entry.action,
      actor: { userId: actor.id, username: actor.username },
      target: target ? { userId: target.id, username: targetUsername } : null,
      scope: entry.where.scope,
      orgId: entry.where.scope === "project" ? null : entry.where.orgId,
      groupId: entry.where.scope === "team" ? entry.where.groupId : null,
      projectId: entry.where.scope === "project" ? entry.where.projectId : (entry.projectId ?? null),
      ...(entry.email !== undefined ? { email: entry.email } : {}),
      roleBefore: entry.roleBefore,
      roleAfter: entry.roleAfter,
    }
    await env.AQUILLA_PG.prepare(
      `INSERT INTO admin_audit_log (user_id, action, detail) VALUES (?, ?, ?)`,
    )
      .bind(actor.id, entry.action, JSON.stringify(detail))
      .run()
  } catch (err) {
    console.error("[admin-audit] membership audit log failed:", err)
  }
}
