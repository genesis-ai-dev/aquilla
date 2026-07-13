// AQU-538: deep-link lane resolution for ProjectWorkspace.
//
// The PM surfaces link into the editor "at the lane they were looking at" via
// `/project/:id?lane=<tag>`. ProjectWorkspace reads the param once on mount and
// sets `activeLane`. This pure helper isolates the (testable) resolution rule
// from the heavyweight component so it can be unit-tested without a harness.

/**
 * Resolve the `?lane=` deep-link param against the project's available lanes.
 *
 * - No param (null / '') → `null`: no deep-link intent, leave the current
 *   (persisted / default) lane untouched.
 * - A param matching an available lane → that lane.
 * - A param that is not an available lane → `''`: an explicit but unknown lane
 *   falls back to the default lane.
 *
 * `availableLanes` is expected to include `''` (the default lane) as its first
 * entry, matching ProjectWorkspace's `["", ...targetLanes]`.
 */
export function resolveDeepLinkLane(
  param: string | null | undefined,
  availableLanes: readonly string[],
): string | null {
  if (!param) return null
  return availableLanes.includes(param) ? param : ''
}
