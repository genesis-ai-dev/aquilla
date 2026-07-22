/**
 * CLIENT MIRROR of sync-worker/src/events/role-policy.ts.
 *
 * The server is authoritative — it gates every event with `requiredRoleFor`
 * and returns 403 when the caller's role is too low. This mirror lets the
 * client refuse to *enqueue* an event the user provably can't perform, so a
 * guaranteed-403 never enters the durable outbox and wedges the queue (the
 * "impossible to arrive at" half of the outbox-wedge fix).
 *
 * Keep this table in lock-step with the server's REQUIRED_ROLE. If they drift,
 * the only cost is a redundant 403 (server still enforces) — never a security
 * hole — but drift defeats the point, so update both together.
 */

export const ROLE = {
  VIEWER: 100,
  COMMENTER: 200,
  REVIEWER: 300,
  CONTRIBUTOR: 400,
  PROJECT_LEAD: 500,
  MAINTAINER: 600,
  OWNER: 700,
} as const

/** Minimum role level required to emit each event kind. Mirrors the server. */
const REQUIRED_ROLE: Record<string, number> = {
  "source.cell.create": ROLE.PROJECT_LEAD,
  "source.cell.commit": ROLE.PROJECT_LEAD,
  "source.cell.delete": ROLE.PROJECT_LEAD,
  "source.cell.reorder": ROLE.PROJECT_LEAD,

  "target.cell.create": ROLE.CONTRIBUTOR,
  "target.cell.commit": ROLE.CONTRIBUTOR,
  "target.cell.delete": ROLE.CONTRIBUTOR,
  "target.cell.reorder": ROLE.CONTRIBUTOR,

  "cell.validate": ROLE.REVIEWER,
  "cell.unvalidate": ROLE.REVIEWER,

  "cell.waive": ROLE.CONTRIBUTOR,
  "cell.unwaive": ROLE.CONTRIBUTOR,

  "cell.audio.attach": ROLE.CONTRIBUTOR,
  "cell.audio.select": ROLE.CONTRIBUTOR,
  "cell.audio.remove": ROLE.CONTRIBUTOR,

  "file.create": ROLE.PROJECT_LEAD,
  "file.rename": ROLE.CONTRIBUTOR,
  "file.delete": ROLE.PROJECT_LEAD,
  "file.restore": ROLE.PROJECT_LEAD,

  "comment.create": ROLE.COMMENTER,
  "comment.edit": ROLE.COMMENTER,
  "comment.delete": ROLE.COMMENTER,
  "comment.resolve": ROLE.COMMENTER,

  "cell.backtranslation.set": ROLE.CONTRIBUTOR,

  "assignment.create": ROLE.PROJECT_LEAD,
  "assignment.reassign": ROLE.PROJECT_LEAD,
  "assignment.unassign": ROLE.PROJECT_LEAD,

  // Timeline editor (mirrors server).
  "cell.retime": ROLE.CONTRIBUTOR,
  "file.video.set": ROLE.CONTRIBUTOR,

  // AQU-478: repin ("accept upstream change as-is") — same authority bar
  // as validating (spec §12). Bulk repin is gated higher (project_lead 500)
  // in the review-panel UI itself, not here.
  "target.cell.repin": ROLE.REVIEWER,
}

/**
 * Required role for a kind, or null when the kind is unknown to this mirror.
 * Returning null (rather than a default) keeps us fail-OPEN: an unmapped kind
 * is allowed through to the server, which stays authoritative. We never block
 * an action the mirror simply hasn't heard of.
 */
export function requiredRoleFor(kind: string): number | null {
  return REQUIRED_ROLE[kind] ?? null
}

/**
 * Whether a caller at `roleLevel` may emit `kind`.
 *
 * Fail-open by design: returns true when the role is unknown (null/undefined)
 * or the kind is unmapped. We only ever return false when we have a concrete
 * role AND a concrete requirement AND the role is below it — i.e. a 403 is
 * certain. This guard exists to prevent guaranteed-poison events, not to
 * replace server authorization.
 */
export function canPerform(kind: string, roleLevel: number | null | undefined): boolean {
  if (roleLevel == null) return true
  const required = requiredRoleFor(kind)
  if (required == null) return true
  return roleLevel >= required
}

/**
 * AQU-496: whether the assign-work UI (AssignModal / AssignWork) should be
 * offered at all, given the caller's role and the org's `allowSelfAssignment`
 * setting. Mirrors the self-assign carve-out enforced server-side in
 * `sync-worker/src/events/authorize.ts` — UX gate only, never the security
 * boundary; the server re-checks independently on every `assignment.create`.
 *
 * Leads/maintainers (>= PROJECT_LEAD) can always open it, regardless of the
 * setting. Below that, a member (CONTRIBUTOR+) can open it ONLY when the org
 * has opted into `allowSelfAssignment` — and even then, `canSubmitAssignment`
 * below still restricts what they can submit to themselves only.
 */
export function canOpenAssignUi(
  roleLevel: number | null | undefined,
  allowSelfAssignment: boolean,
): boolean {
  if (roleLevel == null) return false
  if (roleLevel >= ROLE.PROJECT_LEAD) return true
  return allowSelfAssignment && roleLevel >= ROLE.CONTRIBUTOR
}

/**
 * AQU-496: whether `roleLevel` may submit `assignment.create` assigning
 * `assigneeUserId`. Leads/maintainers may assign anyone. Below-lead callers
 * may ONLY self-assign (assigneeUserId === callerUserId), and only when
 * `allowSelfAssignment` is on — mirrors the server's `isSelfAssignCreate`
 * check in `sync-worker/src/events/authorize.ts`.
 */
export function canSubmitAssignment(
  roleLevel: number | null | undefined,
  allowSelfAssignment: boolean,
  callerUserId: number | null | undefined,
  assigneeUserId: number,
): boolean {
  if (roleLevel == null) return false
  if (roleLevel >= ROLE.PROJECT_LEAD) return true
  if (!allowSelfAssignment || roleLevel < ROLE.CONTRIBUTOR) return false
  return callerUserId != null && callerUserId === assigneeUserId
}

/**
 * AQU-608: whether the editor's TARGET-tag lane switcher is interactive for
 * `roleLevel`. Switching the active translation lane is a maintainer-and-above
 * affordance — every role below maintainer (translators/reviewers/leads) stays
 * in the lane they're on and sees the target-language tag as a static pill, not
 * a dropdown.
 *
 * This is a pure client-side UI gate: selecting a lane emits no event and hits
 * no server endpoint, so there is no server mirror to keep in lock-step. It is
 * intentionally stricter than any event role bar in this file. Fail-CLOSED (an
 * unknown/absent role never gets the switcher) precisely because there is no
 * server backstop here — unlike `canPerform`, which fails open because the
 * server re-checks.
 */
export function canSwitchLanes(roleLevel: number | null | undefined): boolean {
  return roleLevel != null && roleLevel >= ROLE.MAINTAINER
}
