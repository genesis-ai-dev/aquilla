/**
 * deriveTitle — map a route pathname to a human-readable label for the
 * client-side back/forward history popover.
 *
 * This produces a *provisional* label from the URL alone (no data lookups),
 * so every history entry has a sensible name immediately. Pages that know a
 * richer name (e.g. the project + file name) upgrade their entry's title via
 * `useNavHistoryTitle` once that data has loaded.
 */
import { ORG_SETTINGS_SECTION_TITLES, type OrgSettingsSection } from "@/pages/settings/constants"
import { parseOrgPath, ALL_ORGS_PARAM } from "@/lib/navigation/org-paths"

export function deriveNavTitle(pathname: string): string {
  const p = pathname.replace(/\/+$/, "") || "/"
  if (p === "/") return "Home"

  // Global (non-org-prefixed) pages.
  switch (p) {
    case "/projects":
      return "Projects"
    case "/preferences":
      return "Preferences"
    case "/admin":
      return "Admin console"
    case "/shared":
      return "Shared with you"
  }

  const org = parseOrgPath(p)
  if (org) {
    // Portfolio home is Overview-only (no /projects under `/orgs/all`).
    if (org.orgKey === ALL_ORGS_PARAM) return "Overview"
    // Guest org index is the project list; member index redirects to /overview.
    if (org.rest === "") return "Projects"
    const rest = org.rest.replace(/^\//, "")
    const parts = rest.split("/").filter(Boolean)
    switch (parts[0]) {
      case "overview":
        return "Overview"
      case "projects":
        return "Projects"
      case "archived":
        return "Archived projects"
      case "assigned":
        return "Assigned to me"
      case "settings":
        if (parts.length === 1) return "Organization settings"
        return ORG_SETTINGS_SECTION_TITLES[parts[1] as OrgSettingsSection] ?? "Settings"
      case "members":
        return parts[1] === "matrix" ? "Members matrix" : "Members"
      case "teams":
        return parts.length >= 2 ? "Team" : "Teams"
      default:
        break
    }
  }

  const seg = p.split("/").filter(Boolean)

  // /preferences/:section
  if (seg[0] === "preferences" && seg.length === 2) return "Preferences"

  // /projects/:id — single project card view.
  if (seg[0] === "projects" && seg.length === 2) return "Project overview"

  // /project/:id[/<surface>] — workspace shell and its content surfaces.
  if (seg[0] === "project" && seg.length >= 2) {
    switch (seg[2]) {
      case "editor":
        return seg[3] === "file" ? "File" : "Editor"
      case "settings":
        if (seg[3] === "rules") return "Checks & rules"
        if (seg[3] === "memory") return "Project memory"
        return "Project settings"
      case "rules":
        return "Checks & rules"
      case "agent":
        return "Agent"
      case "voice":
        return "Voice"
      case "terminology":
        return "Terminology"
      case "comments":
        return "Comments"
      case "memory":
        return "Project memory"
      default:
        return "Project"
    }
  }

  // Fallback — title-case the last segment.
  const last = seg[seg.length - 1] ?? "Page"
  return last.charAt(0).toUpperCase() + last.slice(1)
}
