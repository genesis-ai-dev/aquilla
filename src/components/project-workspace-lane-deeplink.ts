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

/**
 * `?lane=` accepts a legacy tag or a lane id. An id resolves to that lane's
 * tag, which is what the editor stores. An unknown value still falls back
 * to the default lane.
 */
export function resolveDeepLinkLaneSelection(
  param: string | null | undefined,
  lanes: readonly { id: string; legacyTag: string | null }[],
  availableLanes: readonly string[],
): string | null {
  if (param === null || param === undefined) return null
  const byId = lanes.find((lane) => lane.id === param)
  if (byId) {
    const tag = byId.legacyTag ?? ""
    return availableLanes.includes(tag) ? tag : ""
  }
  return resolveDeepLinkLane(param, availableLanes)
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

/**
 * Query flag on an editor cell link: also OPEN that cell's comment thread
 * (AQU-1259), rather than only scrolling the row into view.
 *
 * The distinction is the whole point of the flag. `?cellId=` is a position —
 * every surface that links into the editor uses it, and none of them wants a
 * side panel forced open. A link that came from a comment is different: the
 * user clicked a specific thread, so landing them on the row with the thread
 * still collapsed makes them hunt for the thing they just clicked. Only the
 * comment surfaces set this, and only they should.
 */
export const OPEN_COMMENTS_PARAM = "comments"

/** The comment (often a reply) a deep link asks the open thread to scroll to. */
export const FOCUS_COMMENT_PARAM = "commentId"

/**
 * The cell whose comment thread a deep link asks to have open, or `null`.
 *
 * Requires BOTH halves: the flag alone names no cell, and `?cellId=` alone is
 * the ordinary scroll-into-view link every other surface builds. Reading them
 * together here — rather than in the component — is what keeps "which links
 * open a panel" one testable rule instead of a condition buried in an effect.
 */
export function openCommentsCellFromSearchParams(
  searchParams: Pick<URLSearchParams, "get">,
): string | null {
  if (searchParams.get(OPEN_COMMENTS_PARAM) !== "1") return null
  const cellId = searchParams.get("cellId")
  return cellId ? cellId : null
}

/**
 * Open the editor on one cell AND open that cell's comment thread.
 *
 * Deliberately not a flag on `editorCellHref`: that builder always emits
 * `?lane=`, and the comment surfaces are not lane-scoped — a thread belongs to
 * a cell, not to one target language, so forcing a lane here would silently
 * move the reader into a language they were not reading (see
 * `resolveDeepLinkLane` on why an ABSENT lane is the correct "leave it alone").
 */
export function editorCommentHref(
  projectId: string,
  fileId: string,
  cellId?: string | null,
  commentId?: string | null,
): string {
  const base = `/project/${encodeURIComponent(projectId)}/editor/file/${encodeURIComponent(fileId)}`
  if (!cellId) return base
  const query = [
    `cellId=${encodeURIComponent(cellId)}`,
    `${OPEN_COMMENTS_PARAM}=1`,
    commentId ? `${FOCUS_COMMENT_PARAM}=${encodeURIComponent(commentId)}` : "",
  ].filter(Boolean).join("&")
  return `${base}?${query}`
}

/**
 * The comment a deep link asks the open thread to scroll to and highlight,
 * or `null` when the link only names the cell.
 */
export function focusedCommentFromSearchParams(
  searchParams: Pick<URLSearchParams, "get">,
): string | null {
  const commentId = searchParams.get(FOCUS_COMMENT_PARAM)
  return commentId ? commentId : null
}

/**
 * Search string after the comments panel closes.
 *
 * Drops the open flag and the focused comment so the URL no longer asks the
 * editor to open the thread. `cellId` stays: it is the row the editor is on,
 * and a bare cell link must not reopen the panel. When neither comment param
 * is present the original string is returned unchanged, so a close that did
 * not come from a deep link does not rewrite the address.
 */
export function searchWithoutCommentDeepLink(search: string): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
  if (!params.has(OPEN_COMMENTS_PARAM) && !params.has(FOCUS_COMMENT_PARAM)) return search
  params.delete(OPEN_COMMENTS_PARAM)
  params.delete(FOCUS_COMMENT_PARAM)
  const next = params.toString()
  return next ? `?${next}` : ""
}
