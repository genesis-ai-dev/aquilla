// AQU-2408: the `cellLabelFloor` vocabulary — who may type a label on a cell.
//
// A cell label is a note on a line (a section name, a reviewer's mark), stored
// as `cells.metadata.cellLabel` by the `cell.label.set` event. It is metadata,
// never a character and never a voice; the decision record is
// docs/decisions/0007-cell-labels-are-metadata-never-cast.md.
//
// THE TIER IS A PRODUCT RULE, ENFORCED WHERE THE FIELD IS DRAWN, exactly as
// `cellEditingFloor` is (see ./cell-editing-floor.ts for the history of that
// split). The sync perimeter applies only the event's static floor, PROJECT_LEAD
// — the lowest rung this setting can admit — through its role-policy table.
//
// The CLIENT keeps its own copy in src/lib/sync/project-settings.ts
// (`resolveCellLabelFloor`), because it cannot import server code. Keep the
// two in lock-step.

/** Role levels, mirroring the ladder both workers already carry. */
const MAINTAINER = 600
const PROJECT_LEAD = 500

/**
 * Stored tier -> the role level it admits. Two rungs by decision (Matt,
 * 2026-11-05): maintainer, the default, and project lead.
 */
const FLOOR_BY_TIER: Record<string, number> = {
  maintainer: MAINTAINER,
  project_lead: PROJECT_LEAD,
}

/** The default when the key is absent, or carries a value this build does not know. */
export const DEFAULT_CELL_LABEL_FLOOR = MAINTAINER

/**
 * The role level a settings blob admits to labelling cells.
 *
 * Unlike the cell-editing tier there is no refusing answer: an absent key, a
 * non-string, and any tier this build does not recognise all read as
 * MAINTAINER. A value a newer client invents must never read as a LOWER floor
 * on an older server, and maintainer is the highest rung offered.
 */
export function cellLabelFloorFromSettings(settings: unknown): number {
  if (typeof settings !== "object" || settings === null) return DEFAULT_CELL_LABEL_FLOOR
  const tier = (settings as { cellLabelFloor?: unknown }).cellLabelFloor
  if (typeof tier !== "string") return DEFAULT_CELL_LABEL_FLOOR
  return FLOOR_BY_TIER[tier] ?? DEFAULT_CELL_LABEL_FLOOR
}
