// AQU-538: deep-link lane resolution for ProjectWorkspace.
//
// The PM surfaces link into the editor "at the lane they were looking at" via
// `/project/:id/editor?lane=<tag>`. ProjectWorkspace reads the param once on mount and
// sets `activeLane`. This pure helper isolates the (testable) resolution rule
// from the heavyweight component so it can be unit-tested without a harness.

/**
 * Resolve the `?lane=` deep-link param against the project's available lanes.
 *
 * - No param (null / undefined) → `null`: no deep-link intent, leave the
 *   current persisted lane untouched.
 * - An explicitly empty param (`?lane=`) → `''`: select Project default.
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
  if (param === null || param === undefined) return null
  return availableLanes.includes(param) ? param : ''
}

/** Preserve the important distinction between an absent lane and `?lane=`. */
export function resolveDeepLinkLaneFromSearchParams(
  searchParams: Pick<URLSearchParams, "get" | "has">,
  availableLanes: readonly string[],
): string | null {
  return resolveDeepLinkLane(
    searchParams.has("lane") ? (searchParams.get("lane") ?? "") : null,
    availableLanes,
  )
}

/** A proposed Autopilot draft always opens the editor's Project-default lane. */
export function defaultLaneDraftReviewHref(
  projectId: string,
  fileId: string,
  cellId?: string | null,
): string {
  const query = cellId
    ? `cellId=${encodeURIComponent(cellId)}&lane=`
    : "lane="
  return `/project/${encodeURIComponent(projectId)}/editor/file/${encodeURIComponent(fileId)}?${query}`
}
