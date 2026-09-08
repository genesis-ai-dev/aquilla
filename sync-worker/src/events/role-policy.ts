import type { EventKind } from './types'

// Numeric role levels matching frontier-server's role hierarchy.
// 100-gaps for future extensibility (e.g. inserting a 350 between
// REVIEWER and CONTRIBUTOR if a workflow ever needs it).
export const ROLE = {
  VIEWER: 100,
  COMMENTER: 200,
  REVIEWER: 300,
  CONTRIBUTOR: 400,
  PROJECT_LEAD: 500,
  MAINTAINER: 600,
  OWNER: 700,
} as const

/**
 * Source of truth for "who can do what" — per AD-2's prefixed-kind design.
 *
 *   source.*  — emitted only by the importer (acting under an admin's
 *               authority) or by an owner who is reshaping source files.
 *               PROJECT_LEAD is the minimum because re-importing a source
 *               affects every downstream linked target (AD-9).
 *
 *   target.*  — translator-level writes. CONTRIBUTOR (400) and above.
 *
 *   cell.validate / cell.unvalidate — REVIEWER (300) and above.
 *
 *   file.create — structural change; PROJECT_LEAD so stray contributors
 *                 can't sprinkle file rows during normal editing.
 *
 * Adding a new EventKind triggers a TypeScript exhaustiveness error here
 * until a row is added — the type system enforces explicit role coverage.
 */
export const REQUIRED_ROLE: Record<EventKind, number> = {
  // Source-side: importer (owner / admin path), or PROJECT_LEAD+ for
  // direct re-imports. The import-bot service account is provisioned at
  // OWNER level out of band.
  //
  // AQU-1068: create/delete/reorder sit at CONTRIBUTOR because this table is
  // the LOWEST reachable floor, not the operative one — reorder included
  // because it is the chain bookkeeping riding every add and remove batch.
  // The real gate is the project's `cellEditingFloor`, applied in authorize.ts:
  // all three are refused outright unless the project opted in, and a delete
  // additionally needs MAINTAINER unless it is a cell a person added by
  // hand (cell-editing-authority.ts).
  'source.cell.create': ROLE.CONTRIBUTOR,
  'source.cell.commit': ROLE.PROJECT_LEAD,
  'source.cell.delete': ROLE.CONTRIBUTOR,
  'source.cell.reorder': ROLE.CONTRIBUTOR,
  'source.cell.metadata.patch': ROLE.PROJECT_LEAD,
  'source.cell.reanchor': ROLE.PROJECT_LEAD,

  // Target-side: translator commits.
  'target.cell.create': ROLE.CONTRIBUTOR,
  'target.cell.commit': ROLE.CONTRIBUTOR,
  'target.cell.delete': ROLE.CONTRIBUTOR,
  'target.cell.reorder': ROLE.CONTRIBUTOR,

  // Validation gate.
  'cell.validate': ROLE.REVIEWER,
  'cell.unvalidate': ROLE.REVIEWER,

  // QA waivers: a translator dismissing a (often false-positive) rule flag on
  // their own cell is normal editing flow, so contributor-level like target.*.
  'cell.waive': ROLE.CONTRIBUTOR,
  'cell.unwaive': ROLE.CONTRIBUTOR,

  // Cell audio: translator-level, like target.* edits.
  'cell.audio.attach': ROLE.CONTRIBUTOR,
  'cell.audio.select': ROLE.CONTRIBUTOR,
  'cell.audio.remove': ROLE.CONTRIBUTOR,
  'cell.audio.rename': ROLE.CONTRIBUTOR,
  'cell.audio.trim': ROLE.CONTRIBUTOR,
  'cell.audio.place': ROLE.CONTRIBUTOR,
  'cell.audio.measure': ROLE.CONTRIBUTOR,

  // AQU-646 (Sam, 2026-08-18): RAISED from CONTRIBUTOR to PROJECT_LEAD.
  // The stage-4 reasoning — "pairing a subtitle line with the audio cue that
  // performs it is ordinary dubbing work" — turned out to be wrong about who
  // does it. The client's own process settles the pairings BEFORE handing off,
  // and the translators and dubbers who receive the file are exactly the
  // contributors who must not be able to re-cut them: a changed link silently
  // moves which line a recording belongs to, for everyone.
  'cell.link.set': ROLE.PROJECT_LEAD,
  // AQU-508: approving/withdrawing approval of a cell's audio is a review
  // action — reviewer(300)+, mirroring the text-side cell.validate gate.
  'cell.audio.validate': ROLE.REVIEWER,
  'cell.audio.unvalidate': ROLE.REVIEWER,

  // file.create is a structural change.
  'file.create': ROLE.PROJECT_LEAD,

  // file.rename is label cleanup ("apply friendly names"), part of normal
  // editing flow — contributor-level, like target.* / cell.waive. It mutates
  // an existing row's display name, not the project's file inventory.
  'file.rename': ROLE.CONTRIBUTOR,
  // Sidebar folder label — same class as file.rename (grouping, not inventory).
  'file.corpus.set': ROLE.CONTRIBUTOR,

  // file.delete/file.restore are structural changes (soft-delete tombstone).
  // Require PROJECT_LEAD (500) — same as file.create and source.* imports.
  'file.delete': ROLE.PROJECT_LEAD,
  'file.restore': ROLE.PROJECT_LEAD,

  // Comments: any commenter+ can write, edit, delete, or resolve their own
  // comment. Server-side ownership enforcement (only the author can edit/delete
  // their own comment) is done in the projector; the role gate is just the
  // minimum bar to participate. Mutating SOMEONE ELSE'S comment is gated
  // separately by FOREIGN_COMMENT_ROLE below (AQU-999).
  'comment.create': ROLE.COMMENTER,
  'comment.edit': ROLE.COMMENTER,
  'comment.delete': ROLE.COMMENTER,
  'comment.resolve': ROLE.COMMENTER,

  // Terminology: CONTRIBUTOR is the floor to PARTICIPATE — it buys you a
  // suggestion (`term.create` with status 'draft'), which compiles to no rules
  // and binds nobody. Every BINDING write (approving, editing, deleting, or
  // creating an already-active term) has the org's configured
  // `termbaseEditMinRole` put back on top of this in authorize.ts — the same
  // conditional-raise shape `source.cell.create` uses for allowLineCreation.
  // Reading this table alone will therefore UNDERSTATE the real floor; see
  // termbase-authority.ts.
  'term.create': ROLE.CONTRIBUTOR,
  'term.update': ROLE.CONTRIBUTOR,
  'term.delete': ROLE.CONTRIBUTOR,
  'term.approve': ROLE.CONTRIBUTOR,
  'term.reject': ROLE.CONTRIBUTOR,

  // Back-translations: writing a BT is a translator-level action (contributor+).
  // Viewing BTs is gated only at the read route (viewer+); the write event
  // is contributor-level matching target.* for consistency.
  'cell.backtranslation.set': ROLE.CONTRIBUTOR,

  // Assignments: a manager (project_lead+) assigns work to members. Reassign
  // and unassign are the same managerial authority.
  'assignment.create': ROLE.PROJECT_LEAD,
  'assignment.reassign': ROLE.PROJECT_LEAD,
  'assignment.unassign': ROLE.PROJECT_LEAD,

  // AD-9: project.link-source is authored by auth-worker on behalf of a
  // project_lead+ actor. The sync-worker accepts it read-only (no client
  // route writes this kind directly); guard at PROJECT_LEAD to match the
  // auth-worker gate.
  'project.link-source': ROLE.PROJECT_LEAD,

  // AQU-438: cast.assign is a metadata-only label written by a PM or project
  // lead who is assigning voice actors to cells.
  //
  // AQU-646 (Sam, 2026-08-18): RAISED from CONTRIBUTOR to PROJECT_LEAD. The
  // original note already said "written by a PM or project lead" — the floor
  // just sat a rung below the people it described. Importing a character sheet
  // rewrites the speaker on hundreds of cells at once, which is project setup,
  // not translation.
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
  'cast.assign': ROLE.MAINTAINER,

  // Timeline editor: retiming a cell (move/stretch) is a translator-level edit.
  'cell.retime': ROLE.CONTRIBUTOR,
  'cell.lane.retime': ROLE.CONTRIBUTOR,
  // Timeline editor: linking a core video to a file.
  //
  // AQU-646 (Sam, 2026-08-18): RAISED from CONTRIBUTOR to PROJECT_LEAD. The
  // file.rename analogy does not hold — a rename changes a label, this changes
  // the FOOTAGE every collaborator times, records and reviews against. It is
  // part of setting a project up, and it is one field away from pointing a
  // whole team at the wrong episode.
  'file.video.set': ROLE.PROJECT_LEAD,
  // The timing mode changes how the whole file lays out and plays for
  // everyone — structural, so it keeps the clearance the setting had when it
  // lived in Project Settings (the shared-settings maintainer floor).
  'file.timing.set': ROLE.MAINTAINER,
  // Track structure IS file structure: renaming, reordering or regrouping a
  // track relayouts the timeline for every collaborator who opens the file —
  // the same rationale that put file.timing.set at this floor. Deliberately
  // NOT the CONTRIBUTOR floor that file.rename and file.video.set sit at;
  // those are normal editing flow, this changes the shared layout.
  'file.track.set': ROLE.MAINTAINER,

  // AQU-476: mirror-engine kinds are server-emitted only (link-sync.ts calls
  // buildEventProjectionStmts directly in-process — never through the client
  // POST /events → authorize() path, so this floor is never actually checked
  // against a caller). Set to MAINTAINER as the nominal "no client may emit
  // this" floor, matching project.link-source's own-authority precedent.
  'source.cell.mirror': ROLE.MAINTAINER,
  'file.mirror': ROLE.MAINTAINER,
  'link.cursor.advance': ROLE.MAINTAINER,

  // AQU-478: repin ("accept upstream change as-is") asserts translation
  // correctness against a new source — same authority bar as validating,
  // per the design spec §12 permissions table. Bulk repin is gated higher
  // (project_lead 500) at the route/UI layer, not here — a single repin's
  // event-kind floor stays reviewer.
  'target.cell.repin': ROLE.REVIEWER,
}

export function requiredRoleFor(kind: EventKind): number {
  return REQUIRED_ROLE[kind]
}

/** Comment kinds whose authority floor is raised when the row belongs to
 *  someone else (the caller is not the comment's author). */
export type ForeignCommentKind = Extract<
  EventKind,
  'comment.edit' | 'comment.delete' | 'comment.resolve'
>

/**
 * AQU-999: authority floors for mutating a comment you did NOT author.
 *
 * These are DYNAMIC bumps on top of the static REQUIRED_ROLE floors above —
 * they apply only once the row's `author_id` is known to differ from the
 * caller. Self-mutation keeps the static COMMENTER (200) floor.
 *
 *   edit / delete — rewriting or removing another person's words is still
 *     MAINTAINER (600). Unchanged.
 *
 *   resolve — LOWERED to CONTRIBUTOR (400). Closing out a thread is thread
 *     bookkeeping, not a mutation of what anyone said: the body is untouched
 *     and the act is reversible by reopening. Translators working a file are
 *     exactly the people who settle the comments on it, so the maintainer bar
 *     made "Resolve" look broken for them — the client flipped the thread
 *     optimistically and the 403 flipped it back. Commenter (200) and
 *     Reviewer (300) still cannot resolve a thread they did not author.
 *
 * Both write paths — the /events perimeter (events/route.ts) and the external
 * Agent API emit path (external/emit-events-engine.ts) — read this table, so
 * the policy cannot drift between them.
 */
export const FOREIGN_COMMENT_ROLE: Record<ForeignCommentKind, number> = {
  'comment.edit': ROLE.MAINTAINER,
  'comment.delete': ROLE.MAINTAINER,
  'comment.resolve': ROLE.CONTRIBUTOR,
}

export function isForeignCommentKind(kind: EventKind): kind is ForeignCommentKind {
  return kind === 'comment.edit' || kind === 'comment.delete' || kind === 'comment.resolve'
}

export function requiredRoleForForeignComment(kind: ForeignCommentKind): number {
  return FOREIGN_COMMENT_ROLE[kind]
}

/** Human-readable name for a role level, for 403 reason strings. */
export function roleLabel(level: number): string {
  const match = Object.entries(ROLE).find(([, v]) => v === level)
  return match ? match[0].toLowerCase() : `role level ${level}`
}
