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
  'source.cell.create': ROLE.PROJECT_LEAD,
  'source.cell.commit': ROLE.PROJECT_LEAD,
  'source.cell.delete': ROLE.PROJECT_LEAD,
  'source.cell.reorder': ROLE.PROJECT_LEAD,

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

  // file.create is a structural change.
  'file.create': ROLE.PROJECT_LEAD,

  // Comments: any contributor+ can write, edit, delete, or resolve their own
  // comment. Server-side ownership enforcement (only the author can edit/delete
  // their own comment) is done in the projector; the role gate is just the
  // minimum bar to participate.
  'comment.create': ROLE.COMMENTER,
  'comment.edit': ROLE.COMMENTER,
  'comment.delete': ROLE.COMMENTER,
  'comment.resolve': ROLE.COMMENTER,
}

export function requiredRoleFor(kind: EventKind): number {
  return REQUIRED_ROLE[kind]
}
