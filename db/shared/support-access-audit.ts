// AQU-2504: the audit trail for connector SUPPORT ACCESS — a platform admin
// reading an org or project through the Agent API / MCP connector on
// platform-admin power rather than on a membership grant.
//
// Why a second audit writer, next to auth-worker/src/services/admin-audit.ts:
// that one records MEMBERSHIP CHANGES, is written from auth-worker, and takes a
// hono-shaped actor. These rows are written from sync-worker, where the whole
// external read tier lives, and db/shared is the only place both workers may
// import from. Same table (`admin_audit_log`), same dotted-action convention,
// same best-effort discipline — so one query over that table still answers
// "what did this operator touch in a tenant they do not belong to".
//
// Actions:
//   connector.orgs.list      — enumerated orgs the admin is not a member of
//   connector.projects.list  — enumerated projects likewise (optionally in one org)
//   connector.project.read   — opened one project on platform power
//
// GRANULARITY. The ticket asks for "one row per org or project touched". A
// single read names exactly one, and gets exactly one row. An enumeration
// touches up to a hundred, and gets ONE row that names all of them in
// `detail.orgIds` / `detail.projectIds`: a hundred rows per `list_orgs` call
// would bury the single reads that actually say what the operator looked at,
// and it is the same reasoning agent_read_audit already applies ("one row per
// agent-facing read CALL, not per cell"). The trail is complete either way.
//
// Best-effort, like admin-audit.ts: the row is written after the read has been
// authorized, and a failed insert is logged, never thrown. Failing the support
// engineer's read because the audit insert lost a race would tell them the data
// is unreachable when it is not, and the read is already authorized by then.
// A write path would deserve the opposite choice — there is none: a support
// credential is minted `access: 'read'`.

import type { AquillaDb } from "../shim/postgres"

export type SupportAccessAuditAction =
  | "connector.orgs.list"
  | "connector.projects.list"
  | "connector.project.read"

export interface SupportAccessAuditEntry {
  action: SupportAccessAuditAction
  /** The credential the read came through — the revoke handle for this trail. */
  credentialId: string
  /** The tool or route that was called, e.g. `list_orgs` or `GET /projects`. */
  tool: string
  /** The one org a single read touched, or the org an enumeration was filtered to. */
  orgId?: string | null
  /** The one project a single read touched. */
  projectId?: string | null
  /** Every org an enumeration returned. */
  orgIds?: string[]
  /** Every project an enumeration returned. */
  projectIds?: string[]
}

/**
 * Record one cross-tenant connector read. Call it ONLY when the access rested
 * on support access — a platform admin reading their own org through the
 * connector is ordinary member-scoped use and must not be logged, or the trail
 * fills with noise that hides the reads it exists to show.
 *
 * `userId` is the acting operator (admin_audit_log.user_id is a BIGINT user id,
 * matching every row admin-audit.ts writes).
 */
export async function auditSupportAccessRead(
  db: AquillaDb,
  userId: string,
  entry: SupportAccessAuditEntry,
): Promise<void> {
  try {
    const detail = {
      action: entry.action,
      actor: { userId: Number(userId) },
      via: "connector",
      credentialId: entry.credentialId,
      tool: entry.tool,
      orgId: entry.orgId ?? null,
      projectId: entry.projectId ?? null,
      ...(entry.orgIds !== undefined ? { orgIds: entry.orgIds } : {}),
      ...(entry.projectIds !== undefined ? { projectIds: entry.projectIds } : {}),
    }
    await db
      .prepare(`INSERT INTO admin_audit_log (user_id, action, detail) VALUES (?, ?, ?)`)
      .bind(Number(userId), entry.action, JSON.stringify(detail))
      .run()
  } catch (err) {
    console.error("[support-access-audit] audit log insert failed:", err)
  }
}
