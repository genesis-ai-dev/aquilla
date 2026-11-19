// AQU-2309: the `milestoneFloor` vocabulary — who may set, rename, resize
// and remove a hand-set milestone.
//
// Two rungs. An absent key, and any value this build does not recognise,
// read as maintainer — the highest rung offered — so a stored tier can never
// be read looser than the default. The role-policy tables carry only the
// static floor PROJECT_LEAD (the lowest rung this setting can admit). The
// events route applies this tier on top, the same way it applies
// harmonize_min_role, which is what rejects a project lead's milestone
// event from a page that has not picked up a raised floor.

/** Role levels, mirroring the ladder both workers already carry. */
const MAINTAINER = 600
const PROJECT_LEAD = 500

/** The default when the key is absent, or carries a value this build does not know. */
export const DEFAULT_MILESTONE_FLOOR = MAINTAINER

/**
 * The role level a stored `milestoneFloor` value admits.
 *
 * The only value that opens the floor to a project lead is the string
 * `"project_lead"`. Everything else — missing, a number, a tier a newer
 * client invents — stays at maintainer.
 */
export function milestoneFloorLevel(tier: unknown): number {
  return tier === "project_lead" ? PROJECT_LEAD : DEFAULT_MILESTONE_FLOOR
}
