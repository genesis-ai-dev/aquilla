/**
 * deriveTitle — map a route pathname to a human-readable label for the
 * client-side back/forward history popover.
 *
 * This produces a *provisional* label from the URL alone (no data lookups),
 * so every history entry has a sensible name immediately. Pages that know a
 * richer name (e.g. the project + file name) upgrade their entry's title via
 * `useNavHistoryTitle` once that data has loaded.
 */
export function deriveNavTitle(pathname: string): string {
  const p = pathname.replace(/\/+$/, "") || "/"
  if (p === "/") return "Home"

  // Org-level pages — exact matches.
  switch (p) {
    case "/projects":
      return "Projects"
    case "/projects/archived":
      return "Archived projects"
    case "/assigned":
      return "Assigned to me"
    case "/preferences":
      return "Preferences"
    case "/settings":
      return "Organization settings"
    case "/members":
      return "Members"
    case "/teams":
      return "Teams"
    case "/admin":
      return "Admin console"
  }

  const seg = p.split("/").filter(Boolean)

  // /projects/:id — single project card view.
  if (seg[0] === "projects" && seg.length === 2) return "Project overview"
  // /teams/:groupId
  if (seg[0] === "teams" && seg.length === 2) return "Team"

  // /project/:id[/<surface>] — workspace shell and its content surfaces.
  if (seg[0] === "project" && seg.length >= 2) {
    switch (seg[2]) {
      case undefined:
        return "Editor"
      case "file":
        return "File"
      case "settings":
        return "Project settings"
      case "rules":
        return "Checks & rules"
      case "voice":
        return "Voice"
      case "terminology":
        return "Terminology"
      case "comments":
        return "Comments"
      case "memory":
        return "Project memory"
      case "members":
        return "Project members"
      default:
        return "Project"
    }
  }

  // Fallback — title-case the last segment.
  const last = seg[seg.length - 1] ?? "Page"
  return last.charAt(0).toUpperCase() + last.slice(1)
}
