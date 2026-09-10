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
  // Sam, 2026-08-21: create/delete/reorder sit at CONTRIBUTOR so the "let
  // people add new lines" project setting can admit contributors. Reorder is
  // in the set because it is the chain bookkeeping RIDING every add and
  // remove (handleAddLine/handleRemoveLine batch it in), and a floor that
  // refused it silently killed the whole batch. This static floor is the
  // LOWEST reachable one; the server conditionally re-imposes PROJECT_LEAD —
  // all three refused below lead unless the project opted in, deletes
  // additionally only for a cell a person added by hand (sync-worker
  // authorize.ts + line-creation-authority.ts). The client gate's own rule
  // applies: only block what is PROVABLY insufficient, and with the
  // carve-out a contributor no longer is.
  "source.cell.create": ROLE.CONTRIBUTOR,
  "source.cell.commit": ROLE.PROJECT_LEAD,
  "source.cell.delete": ROLE.CONTRIBUTOR,
  "source.cell.reorder": ROLE.CONTRIBUTOR,

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
  "cell.audio.rename": ROLE.CONTRIBUTOR,
  "cell.audio.trim": ROLE.CONTRIBUTOR,
  "cell.audio.place": ROLE.CONTRIBUTOR,
  // AQU-646: project lead, not contributor. The pairings are settled during
  // setup and handed off; a contributor re-cutting one silently moves which
  // line a recording belongs to, for everyone.
  "cell.link.set": ROLE.PROJECT_LEAD,
  "cell.audio.measure": ROLE.CONTRIBUTOR,

  "file.create": ROLE.PROJECT_LEAD,
  "file.rename": ROLE.CONTRIBUTOR,
  "file.corpus.set": ROLE.CONTRIBUTOR,
  "file.delete": ROLE.PROJECT_LEAD,
  "file.restore": ROLE.PROJECT_LEAD,

  // These are the SELF floors — the bar to touch your own comment. Acting on
  // someone else's carries a second, higher floor; see FOREIGN_COMMENT_ROLE.
  // Terminology: CONTRIBUTOR buys a SUGGESTION (`term.create` status 'draft').
  // Every binding write additionally needs the org's `termbaseEditMinRole`,
  // which only the server can resolve — this client table is the optimistic
  // floor, and the server is the authority (sync-worker termbase-authority.ts).
  "term.create": ROLE.CONTRIBUTOR,
  "term.update": ROLE.CONTRIBUTOR,
  "term.delete": ROLE.CONTRIBUTOR,
  "term.approve": ROLE.CONTRIBUTOR,
  "term.reject": ROLE.CONTRIBUTOR,
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
  "cell.lane.retime": ROLE.CONTRIBUTOR,
  // AQU-646: the linked film is what the whole team times, records and reviews
  // against — project setup, not an edit.
  "file.video.set": ROLE.PROJECT_LEAD,
  // AQU-646: MISSING FROM THIS MIRROR until 2026-08-18, which is why the
  // character-import button appeared for everyone — `canPerform` fails open on
  // a kind it has never heard of, so the UI's own gate always said yes and the
  // server's 403 was the only thing stopping anyone.
  //
  // AQU-646 (Sam, 2026-08-20): RAISED AGAIN, to MAINTAINER. Characters are one
  //   person's job here — the client's producer owns the sheets, and she holds
  //   maintainer. Nobody below her reconciles the two sheets against each other,
  //   so the resolve drawer this event also backs has an audience of one and does
  //   not need a lower floor to stay reachable.
  // 
  //   KNOWN CONSEQUENCE, accepted deliberately: `cast.assign` also carries the
  //   older CSV label round-trip (AQU-438 — download a template, fill in a
  //   `cast_name` column, re-upload), which has no UI role gate of its own. That
  //   flow now needs maintainer too. It surfaces as the panel's inline error rather
  //   than a crash, because the client mirror throws before anything reaches the
  //   durable outbox.
  "cast.assign": ROLE.MAINTAINER,
  // Structural — keeps the clearance the setting had in Project Settings.
  "file.timing.set": ROLE.MAINTAINER,
  // Track structure IS file structure: a rename or reorder relayouts the
  // timeline for everyone who opens the file, so it sits with file.timing.set
  // rather than with the contributor-level file.rename / file.video.set.
  "file.track.set": ROLE.MAINTAINER,

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
 * AQU-1000 — CLIENT MIRROR of the server's foreign-comment floors.
 *
 * `REQUIRED_ROLE` above is only half the comment policy. Every comment
 * mutation carries a SECOND floor that applies when the target comment was
 * written by somebody else: the server re-checks `author_id` against the
 * caller's username at the `/events` perimeter (`sync-worker/src/events/
 * route.ts`) and again on the external Agent API emit path
 * (`sync-worker/src/external/emit-events-engine.ts`), and 403s below this bar.
 *
 * The client mirrored only the static table, so the UI offered Resolve /
 * Close-with-reply / Reopen on threads the server was always going to refuse.
 * Because `useComments.resolveThread` flips `resolved` optimistically, the
 * thread visibly closed and then sprang back open — a promise the system
 * never intended to keep. Mirroring the foreign floor is what lets the UI
 * decide honestly, per thread, before it offers the control.
 *
 * `comment.resolve` sits at CONTRIBUTOR because closing a thread is
 * bookkeeping, not a rewrite of anyone's words: the body is untouched and the
 * act is reversible by reopening. `comment.edit` / `comment.delete` mutate
 * what another person actually said, so they stay at MAINTAINER.
 *
 * DEPENDENCY: the CONTRIBUTOR floor for foreign resolve is AQU-999's change
 * to the server (both write paths). Until that lands, the server still
 * enforces MAINTAINER here and a contributor's foreign resolve is refused —
 * so keep these two in lock-step, exactly as the mirror's header demands.
 */
export const FOREIGN_COMMENT_ROLE: Record<string, number> = {
  "comment.resolve": ROLE.CONTRIBUTOR,
  "comment.edit": ROLE.MAINTAINER,
  "comment.delete": ROLE.MAINTAINER,
}

/**
 * Minimum role to act on a comment kind that somebody ELSE authored, or null
 * when the kind carries no foreign floor (fail-open, as `requiredRoleFor`).
 */
export function foreignRoleFor(kind: string): number | null {
  return FOREIGN_COMMENT_ROLE[kind] ?? null
}

/**
 * AQU-1000: the floor that actually applies to `kind` for this caller on this
 * comment — the self floor when they wrote it, the (higher) foreign floor when
 * they did not. Returns null when nothing is provably required, matching
 * `requiredRoleFor`'s fail-open contract.
 *
 * `isOwnComment` is deliberately a caller-supplied boolean rather than a pair
 * of usernames: the drawer compares a thread's root author, the Comments page
 * compares a record's `authorId`, and both already hold the session username.
 */
export function effectiveCommentRoleFor(kind: string, isOwnComment: boolean): number | null {
  const self = requiredRoleFor(kind)
  if (isOwnComment) return self
  const foreign = foreignRoleFor(kind)
  if (foreign == null) return self
  if (self == null) return foreign
  return Math.max(self, foreign)
}

/**
 * AQU-1000: whether `roleLevel` may perform `kind` on a comment, accounting
 * for who wrote it.
 *
 * Fail-open on an unknown role (null = a local / git-imported project with no
 * sync role), same contract as `canPerform` — we only ever return false when a
 * 403 is certain, because the server remains the security boundary. The point
 * here is honesty in the UI, not enforcement.
 */
export function canMutateComment(
  kind: string,
  roleLevel: number | null | undefined,
  isOwnComment: boolean,
): boolean {
  if (roleLevel == null) return true
  const required = effectiveCommentRoleFor(kind, isOwnComment)
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
 * A caller at the org's assignmentMinRole can open it for any assignee.
 * Below that floor, CONTRIBUTOR+ can open it only when the org has opted into
 * allowSelfAssignment, and canSubmitAssignment restricts them to themselves.
 */
export function canOpenAssignUi(
  roleLevel: number | null | undefined,
  allowSelfAssignment: boolean,
  assignmentMinRole: number = ROLE.PROJECT_LEAD,
): boolean {
  if (roleLevel == null) return false
  if (roleLevel >= assignmentMinRole) return true
  return allowSelfAssignment && roleLevel >= ROLE.CONTRIBUTOR
}

/**
 * AQU-496: whether `roleLevel` may submit `assignment.create` assigning
 * `assigneeUserId`. Callers at assignmentMinRole may assign anyone.
 * Below-floor callers may only self-assign (assigneeUserId === callerUserId),
 * and only when allowSelfAssignment is on.
 */
export function canSubmitAssignment(
  roleLevel: number | null | undefined,
  allowSelfAssignment: boolean,
  callerUserId: number | null | undefined,
  assigneeUserId: number,
  assignmentMinRole: number = ROLE.PROJECT_LEAD,
): boolean {
  if (roleLevel == null) return false
  if (roleLevel >= assignmentMinRole) return true
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
