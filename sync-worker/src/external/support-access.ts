// AQU-2504: connector SUPPORT ACCESS — the one place the external tier decides
// whether a call rests on a platform admin's time-boxed cross-tenant grant.
//
// Extracted from read-auth.ts when the WRITES half landed, for the reason the
// read gate itself was extracted from read-routes.ts (AQU-1232): the moment two
// surfaces each carry their own copy of an access rule, one of them gains a
// check the other never gets. Reads and writes now share this module, so the
// three live conditions, the "tried last" ordering and the audit are decided
// once and cannot drift apart.
//
// THE THREE CONDITIONS are not re-checked here — `credential.supportAccess` is
// already their conjunction, computed on every call in validateApiCredential
// (db/shared/api-credentials.ts): the `support_access` grant ticked at consent,
// an unexpired `support_access_until`, and a `platform_admins` row for the
// owner right now. Any one lapsing returns the credential to ordinary member
// scope on the next request.
//
// TWO RULES hold for reads and writes alike:
//
//   1. It widens who counts as a MEMBER, never the credential's own scope. The
//      org/project narrowing on the credential (steps 1-2 of either gate) is
//      untouched — a support credential is simply minted with no scope.
//   2. It is tried LAST, after the live role has resolved to nothing. A
//      platform admin acting inside an org they genuinely belong to resolves on
//      their genuine grant, keeps that attribution, and is not audited: the
//      trail exists to show what an operator touched in a tenant they do not
//      belong to, and filling it with their own org's traffic hides exactly
//      that.
//
// READS AND WRITES DIFFER IN ONE WAY, and it is the audit. A read's row is
// best-effort and written after authorization; a write's row is written BEFORE
// the write token is minted and a failed insert REFUSES the write. See the
// discipline note in db/shared/support-access-audit.ts.

import type { ApiCredentialContext } from "../../../db/shared/api-credentials"
import {
  auditSupportAccessRead,
  auditSupportAccessWrite,
} from "../../../db/shared/support-access-audit"

/**
 * Owner-level, the contribution `resolveProjectRoleShared` gives the `platform`
 * path. Mirrors ROLE.OWNER / db/shared/project-roles.ts.
 *
 * Support access resolves HERE and no higher: it is the same level a platform
 * operator already holds on the web through the AD-12 `platform` path, so a
 * support engineer's reach inside a project is exactly an owner's, never more.
 */
export const PLATFORM_ROLE_LEVEL = 700

/**
 * May this credential open `projectId` on SUPPORT ACCESS alone, and if so,
 * record the read?
 *
 * Call it only AFTER the live role has resolved to nothing (rule 2 above).
 * Returns false and writes nothing for every credential without live support
 * access, which is every credential but a platform admin's inside their window.
 *
 * Deliberately NOT implemented by passing the platform-admin allowlist into
 * `resolveProjectRoleShared`: that would hand every connector credential of
 * every platform admin cross-tenant reach, which is exactly the blanket
 * elevation this ticket replaces with an opt-in, time-boxed grant.
 */
export async function claimSupportAccess(
  db: AquillaDb,
  credential: ApiCredentialContext,
  projectId: string,
  tool: string,
  orgId: string | null,
): Promise<boolean> {
  if (credential.supportAccess !== true) return false
  await auditSupportAccessRead(db, credential.userId, {
    action: "connector.project.read",
    credentialId: credential.credentialId,
    tool,
    orgId,
    projectId,
  })
  return true
}

/**
 * The WRITE counterpart (AQU-2504 writes half): may this credential write in
 * `projectId` on support access alone?
 *
 * Differs from {@link claimSupportAccess} in exactly two ways, both because a
 * write is not a read:
 *
 *   - The audit row is written BEFORE the caller proceeds, and this function
 *     THROWS if the insert fails, so an unrecordable cross-tenant write is
 *     refused rather than applied untraceably.
 *   - It additionally requires the credential to be write-capable at all
 *     (`access !== 'read'`). A support engineer who connected a read-only host
 *     gets the read widening and nothing else — support access grants reach
 *     across tenants, it does not upgrade a read-only token.
 *
 * @throws whatever the audit insert threw, for the caller to turn into a refusal.
 */
export async function claimSupportAccessForWrite(
  db: AquillaDb,
  credential: ApiCredentialContext,
  projectId: string,
  tool: string,
  orgId: string | null,
  /** The file this write token is for, when there is one — the row names it so
   *  a multi-file commit's several rows each say something distinct. */
  fileId?: string | null,
): Promise<boolean> {
  if (credential.supportAccess !== true) return false
  if (credential.access === "read") return false
  await auditSupportAccessWrite(db, credential.userId, {
    credentialId: credential.credentialId,
    tool,
    orgId,
    projectId,
    ...(fileId ? { fileId } : {}),
  })
  return true
}

/** What a caller's role resolved to, and which path produced it. */
export interface CallerProjectRole {
  /** Live-resolved role level. */
  level: number
  /**
   * True when the ONLY thing granting this project was support access — the
   * caller has no genuine grant here. Write surfaces stamp it onto the event's
   * provenance so the org's own members can see a platform admin did this.
   */
  viaSupportAccess: boolean
}

/**
 * Resolve the CALLER's live role on a project for a WRITE surface, with support
 * access as the last path tried.
 *
 * The external write tier had ~nine sites each running
 * `resolveProjectRoleShared(db, { id: cred.userId }, projectId)` and refusing on
 * null — prepare, commit, the changeset authority check, the changesets routes
 * and the token bridge. Threading support access through each by hand is how
 * one of them ends up with a check the others never got, so they resolve here
 * instead.
 *
 * `resolveProjectRole` is injected rather than imported so this module stays
 * free of the project-roles import graph and the callers keep using the exact
 * resolver they already used (archived-project semantics included).
 *
 * @throws from the write audit — see {@link claimSupportAccessForWrite}.
 */
export async function resolveCallerProjectRoleForWrite(
  db: AquillaDb,
  credential: ApiCredentialContext,
  projectId: string,
  /** The tool or route asking, named in the audit row. */
  tool: string,
  resolveProjectRole: (
    db: AquillaDb,
    user: { id: string },
    projectId: string,
  ) => Promise<{ level: number } | null>,
  /** The file the write token is for, named in the audit row when present. */
  fileId?: string | null,
): Promise<CallerProjectRole | null> {
  const resolved = await resolveProjectRole(db, { id: credential.userId }, projectId)
  if (resolved) return { level: resolved.level, viaSupportAccess: false }

  // Short-circuit BEFORE the org lookup. Every ordinary non-member refusal
  // reaches this line, and `projectOrgId` is read only to name the org in an
  // audit row — so a credential that cannot possibly claim support access must
  // not pay a query for it.
  if (credential.supportAccess !== true || credential.access === "read") return null

  const orgId = await projectOrgId(db, projectId)
  if (await claimSupportAccessForWrite(db, credential, projectId, tool, orgId, fileId)) {
    return { level: PLATFORM_ROLE_LEVEL, viaSupportAccess: true }
  }
  return null
}

/**
 * The same resolution for a write surface's EARLY gate — changeset prepare,
 * commit's role floor, the changeset authority check, the changesets routes.
 *
 * Identical to {@link resolveCallerProjectRoleForWrite} but for the audit: it
 * records a cross-tenant READ, not a write, and best-effort rather than
 * fail-closed.
 *
 * Why the distinction matters. These gates do not change anything in the
 * customer's project; they expose its state — whether a cell exists, the
 * server-computed effect summary, a stored changeset, the role floors. On
 * support access that is exactly a cross-tenant read, and recording it as a
 * write would put rows in the trail saying an operator edited a project they
 * only looked at. The actual write is audited once, at the one door every
 * external event write goes through (`mintInternalSyncToken`), so a prepare →
 * commit sequence leaves one read row per call plus one write row for the write
 * itself, rather than the same act counted three times as three writes.
 *
 * A write-capable credential is NOT required here, for the same reason: a
 * read-only support credential may legitimately reach these surfaces, and the
 * write ceiling refuses it at the door (`assertCredentialMayWrite`).
 */
export async function resolveCallerProjectRoleForGate(
  db: AquillaDb,
  credential: ApiCredentialContext,
  projectId: string,
  /** The tool or route asking, named in the audit row. */
  tool: string,
  resolveProjectRole: (
    db: AquillaDb,
    user: { id: string },
    projectId: string,
  ) => Promise<{ level: number } | null>,
): Promise<CallerProjectRole | null> {
  const resolved = await resolveProjectRole(db, { id: credential.userId }, projectId)
  if (resolved) return { level: resolved.level, viaSupportAccess: false }

  // See the note in resolveCallerProjectRoleForWrite: short-circuit before the
  // org lookup so an ordinary refusal costs nothing extra.
  if (credential.supportAccess !== true) return null

  const orgId = await projectOrgId(db, projectId)
  if (await claimSupportAccess(db, credential, projectId, tool, orgId)) {
    return { level: PLATFORM_ROLE_LEVEL, viaSupportAccess: true }
  }
  return null
}

/** The project's org, for the audit row. Null when the project has none (or is
 *  missing — the caller's own scope check reports that, not this). */
export async function projectOrgId(db: AquillaDb, projectId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT org_id FROM projects WHERE id = ?")
    .bind(projectId)
    .first<{ org_id: number | string | bigint | null }>()
  return row?.org_id == null ? null : String(row.org_id)
}
