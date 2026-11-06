// AQU-2408: who is offered the Label field on a cell.
//
// A cell label is a note typed on a line — a section name, a reviewer's mark.
// It is metadata, never a character and never a voice
// (docs/decisions/0007-cell-labels-are-metadata-never-cast.md).
//
// Two floors, in the same arrangement as the cell-editing tier
// (src/lib/cell-editing-gate.ts): the sync perimeter applies only the event's
// STATIC floor (project lead, `role-policy.ts`), and the project's own tier —
// `cellLabelFloor`, maintainer unless set otherwise — is a product rule
// enforced here, where the field is drawn. This module is that enforcement.
// Pulled out of EditorTable so the truth table has a test harness.

import { canPerform } from "@/lib/sync/role-policy"
import { resolveCellLabelFloor, type ProjectWideSettings } from "@/lib/sync/project-settings"

export interface CellLabelSubject {
  /** The viewer's level on this project; null when they have none (or it is unknown). */
  roleLevel: number | null | undefined
  /** The project's tier, as the record carries it (`cellLabelFloor`). */
  settings: Pick<ProjectWideSettings, "cellLabelFloor"> | null | undefined
}

/**
 * May this person type the label on a cell of this project?
 *
 * Unlike `canPerform`, an UNKNOWN role does not fail open: the field is an
 * affordance, and offering it to someone the server will refuse is the one
 * thing a tier exists to prevent.
 */
export function canEditCellLabel(subject: CellLabelSubject): boolean {
  const level = subject.roleLevel
  if (level == null) return false
  if (!canPerform("cell.label.set", level)) return false
  return level >= resolveCellLabelFloor(subject.settings)
}
