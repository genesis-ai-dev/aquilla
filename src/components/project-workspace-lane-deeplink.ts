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

/**
 * Open the editor on one cell of one file, in one lane.
 *
 * This is the single "take me to that cell" link builder — Autopilot draft
 * review used to own it under the name `draftReviewHref`, and AQU-1278's plan
 * board ("go to the first outstanding cell") is the second, unrelated caller.
 *
 * The contract, in the order the editor applies it:
 *
 * - `lane` is ALWAYS emitted, including as the empty `?lane=` that means
 *   "Project default". That is deliberate and it is the part callers get
 *   wrong: `resolveDeepLinkLane` reads an ABSENT lane param as "no deep-link
 *   intent, leave whatever lane the editor last had". So a link built by a
 *   surface that is itself lane-scoped — a plan row for one target language, a
 *   draft in one Autopilot run's language — must always pass `targetLang`, or
 *   the user lands on the right cell in the WRONG language and reads someone
 *   else's translation as their own.
 * - `cellId` is the row to scroll to. It is optional because a file-level link
 *   ("open this file") is a legitimate use; without it nothing is scrolled.
 * - `flash` appends `&flash=1`, which makes ProjectWorkspace briefly highlight
 *   the row it scrolled to. Pass it whenever the LINK TEXT made a promise
 *   about a specific cell: a scroll with no marker looks, from the user's
 *   chair, exactly like a link that did nothing. It rides with `cellId` only —
 *   there is nothing to flash without a row, and the reader ignores it there.
 */
export function editorCellHref(
  projectId: string,
  fileId: string,
  cellId?: string | null,
  targetLang = "",
  flash = false,
): string {
  const lane = `lane=${encodeURIComponent(targetLang)}`
  const query = cellId
    ? `cellId=${encodeURIComponent(cellId)}&${lane}${flash ? "&flash=1" : ""}`
    : lane
  return `/project/${encodeURIComponent(projectId)}/editor/file/${encodeURIComponent(fileId)}?${query}`
}

/** @deprecated Use editorCellHref. Autopilot's original name for it. */
export const draftReviewHref = editorCellHref

/** @deprecated Use editorCellHref. Kept for existing default-lane callers. */
export function defaultLaneDraftReviewHref(
  projectId: string,
  fileId: string,
  cellId?: string | null,
): string {
  return editorCellHref(projectId, fileId, cellId, "")
}
