/**
 * AQU-1510: does a new assignment cover lines its assignee already holds?
 *
 * The Pattani Malay team saw "two projects per book" because one translator
 * held a whole book AND a list of its chapters (Matthew's 1,071 is exactly
 * its verse count). Nothing stopped a manager making the second one, and
 * nothing said it overlapped the first. Sam's ruling (Oct 21): warn, don't
 * block — two people, or one person twice, on the same lines can be meant.
 *
 * Only the same person, the same kind of work and the same language count.
 * A validate assignment over someone's own translate assignment is a
 * different job, and a French assignment never doubles a Spanish one.
 */

import { laneTagForAssignment } from "./assignment-lane"
import type { AssignmentKind, UnitAssignment } from "./assignments"

/** What the new assignment covers in one file. */
export type OverlapScope = { kind: "file" } | { kind: "chapters"; chapters: string[] }

export interface AssignmentOverlap {
  /** The overlapped assignments' labels, as stored ("All verses", "Matthew · MAT 21, …"). */
  scopeLabels: string[]
  /**
   * Chapter keys ("MAT 21") the new assignment would cover a second time.
   * Empty when the server sent no per-chapter breakdown (an older worker);
   * the labels above then stand in.
   */
  chapters: string[]
}

export interface OverlapQuery {
  assigneeUserId: number
  /** The new assignment's lane as the picker holds it; '' / "default" / absent = the default lane. */
  lane: string | null | undefined
  kind: AssignmentKind
  scope: OverlapScope
}

function sameLane(a: string | null | undefined, b: string | null | undefined): boolean {
  return (laneTagForAssignment(a ?? "") ?? "") === (laneTagForAssignment(b ?? "") ?? "")
}

/**
 * The part of `existing` (every live assignment on one file, from
 * `getUnitAssignments` with section '') that `query` would cover again, or
 * null when it covers nothing anyone already holds.
 */
export function findAssignmentOverlap(
  existing: readonly UnitAssignment[],
  query: OverlapQuery,
): AssignmentOverlap | null {
  const wanted = query.scope.kind === "chapters" ? new Set(query.scope.chapters) : null
  const labels: string[] = []
  const chapters = new Set<string>()
  for (const a of existing) {
    if (a.assigneeUserId !== query.assigneeUserId) continue
    if ((a.kind ?? "translate") !== query.kind) continue
    if (!sameLane(a.targetLang, query.lane)) continue
    if (!a.chapters) {
      // An older worker sends no breakdown: any lines held at all count.
      if (a.cellsTotal > 0) labels.push(a.scopeLabel)
      continue
    }
    const held = a.chapters.filter((c) => c.total > 0).map((c) => c.key)
    const both = wanted ? held.filter((key) => wanted.has(key)) : held
    if (both.length === 0) continue
    labels.push(a.scopeLabel)
    for (const key of both) chapters.add(key)
  }
  if (labels.length === 0) return null
  return { scopeLabels: labels, chapters: [...chapters] }
}
