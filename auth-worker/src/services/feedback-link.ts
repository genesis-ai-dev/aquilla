// The "Page" link on a "Report a problem" email and Discord post (AQU-2466).
//
// The SPA sends the pathname the user was on ("/project/p1/file/f1"). A bare
// path tells the reader nothing and cannot be clicked, so both senders turn it
// into a link to the same page on production, behind short text: the project
// name when there is one, otherwise the path itself.
//
// Always production, never the host the report came from: triage decided the
// recipients (support inboxes, the team channel) read reports from prod, and a
// dev or preview host would hand them a link to the wrong data.

export const FEEDBACK_LINK_ORIGIN = "https://aquilla.app"

export interface FeedbackPageLink {
  /** Short text a reader sees. */
  text: string
  /** Absolute https://aquilla.app/... URL. */
  url: string
}

/**
 * Build the link, or null when the route is not a same-site path. The route is
 * typed by the client, so anything that would leave aquilla.app ("//evil.test",
 * "https://…", "javascript:…") gets no link and is shown as plain text instead.
 */
export function feedbackPageLink(
  route: string,
  projectName?: string | null,
): FeedbackPageLink | null {
  const path = route.trim()
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return null
  let url: URL
  try {
    url = new URL(path, FEEDBACK_LINK_ORIGIN)
  } catch {
    return null
  }
  if (url.origin !== FEEDBACK_LINK_ORIGIN) return null
  const text = projectName?.trim() || path
  return { text, url: url.href }
}
