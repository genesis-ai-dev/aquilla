/**
 * Client mirror of the project-membership grant rules enforced by
 * `auth-worker` on `POST /api/v2/projects/:projectId/members`
 * (`grantProjectMemberOne` + its route guard in
 * `auth-worker/src/routes/projects.ts`).
 *
 * AQU-853: the in-project Members surface used to hardcode
 * `callerMaxRole = ROLE.MAINTAINER`, so every reader — including a
 * contributor who cannot manage members at all — was offered a "Change role"
 * submenu listing grants up to Maintainer. The server answered 403 and the
 * row menu said nothing about why. This module is the single place those
 * rules live on the client so the three member surfaces (settings
 * MembersSection, SharePanel, the org members matrix) cannot drift from the
 * server or from each other again.
 *
 * The server remains the security boundary — everything here is a UX hint
 * that keeps the UI from offering an action it knows will be refused, and
 * lets it explain the refusal instead of rendering nothing.
 */
import { PROJECT_ROLE_OPTIONS, ROLE, type RoleOption } from "./roles"

/**
 * Role floor for managing project membership at all. Mirrors the route guard
 * `if (callerRole.level < 500) return 403 "role >= project_lead required"`.
 */
export const MEMBER_GRANT_MIN_ROLE = ROLE.PROJECT_LEAD

/**
 * Why a role change is unavailable for a given (caller, target) pair. Each
 * value maps 1:1 onto a server refusal so the copy can name the real reason:
 *
 * - `caller-below-floor`   → route guard, `role >= project_lead required`
 * - `self`                 → `self_grant`
 * - `target-outranks-caller` → `target_outranks_caller`
 * - `locked`               → not a server code: the target's access comes
 *   from the org roster or from being the project creator, so there is no
 *   direct grant on this project to change (the roster already annotates
 *   this per row; "Revoke all access" is the action that applies).
 */
export type RoleChangeBlock =
  | "caller-below-floor"
  | "self"
  | "locked"
  | "target-outranks-caller"

export interface RoleChangeContext {
  /**
   * The caller's own effective role level on this project, or `null` when it
   * isn't known yet (roster still loading, or the caller has no row). `null`
   * is treated as "don't block" — the server still refuses what it must, and
   * a transient null must not hide the control from an owner.
   */
  callerLevel: number | null
  /** The target member's current effective role level. */
  targetLevel: number
  /** True when the target row is the caller's own. */
  isSelf: boolean
  /**
   * True when the target's access is inherited (`org`) or intrinsic
   * (`creator`) rather than a direct project grant.
   */
  isLocked: boolean
}

/**
 * The reason a role change is blocked, or `null` when the caller may change
 * this member's role. Checked in the same order the server checks, so the
 * reason shown is the one the server would have reported.
 */
export function roleChangeBlock(ctx: RoleChangeContext): RoleChangeBlock | null {
  const { callerLevel, targetLevel, isSelf, isLocked } = ctx
  if (callerLevel !== null && callerLevel < MEMBER_GRANT_MIN_ROLE) {
    return "caller-below-floor"
  }
  if (isSelf) return "self"
  if (isLocked) return "locked"
  // AQU-285 (F-B6), mirrored: a non-owner cannot modify a member whose
  // current level is at or above their own. Owners may modify anyone.
  if (
    callerLevel !== null &&
    callerLevel < ROLE.OWNER &&
    targetLevel >= callerLevel
  ) {
    return "target-outranks-caller"
  }
  return null
}

/**
 * The project-picker roles this caller may actually grant — never above
 * their own level, mirroring the server's `role > callerRole.level` refusal.
 * A `null` caller level keeps the full picker (see `RoleChangeContext`).
 */
export function grantableProjectRoles(callerLevel: number | null): RoleOption[] {
  if (callerLevel === null) return [...PROJECT_ROLE_OPTIONS]
  return PROJECT_ROLE_OPTIONS.filter((r) => r.level <= callerLevel)
}

/** True when this caller may manage project membership at all. */
export function canManageProjectMembers(callerLevel: number | null): boolean {
  return callerLevel === null || callerLevel >= MEMBER_GRANT_MIN_ROLE
}
