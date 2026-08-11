/**
 * Shared Lucide icons for org-shell pages — sidebar and the previously-viewed
 * history menu both read from here so a page keeps one glyph.
 *
 * Chosen via Lucide MCP (`fuzzy_search_icons` / category fit):
 * - Overview → LayoutDashboard (org home / operator surface)
 * - Projects → Library (collection of works; Text formatting / Navigation)
 * - Teams → SquareUserRound (Accounts & access)
 * - Members → Users (people-group; Accounts & access)
 * - Assigned → ListTodo (task list)
 * - Archived → Archive (File icons)
 * - Settings → Settings (Accounts & access)
 * - Admin → ShieldUser (Accounts & access / Security)
 * - Shared → Share2 (Social / Accounts & access)
 * - Preferences → SlidersHorizontal (Accounts & access)
 * - Organizations → Building2 (Buildings)
 * - Project → FolderOpen (File icons)
 * - File → FileText (File icons)
 * - Editor → BookOpenText (Text formatting)
 * - Terminology → Languages (Text formatting)
 * - Memory → BrainCircuit (Coding & development)
 */
import type { LucideIcon } from "lucide-react"
import {
  Archive,
  BookOpenText,
  Bot,
  BrainCircuit,
  Building2,
  Download,
  EyeOff,
  FileText,
  FolderOpen,
  KeyRound,
  Languages,
  LayoutDashboard,
  Library,
  ListTodo,
  MessageSquare,
  Mic,
  Settings,
  Share2,
  ShieldUser,
  SlidersHorizontal,
  SpellCheck,
  SquareUserRound,
  UserCheck,
  Users,
  Workflow,
} from "lucide-react"
import { parseOrgPath, ALL_ORGS_PARAM } from "@/lib/navigation/org-paths"

/** Canonical icons for the org sidebar destinations. */
export const NAV_PAGE_ICONS = {
  overview: LayoutDashboard,
  projects: Library,
  teams: SquareUserRound,
  assigned: ListTodo,
  members: Users,
  archived: Archive,
  settings: Settings,
  admin: ShieldUser,
  shared: Share2,
  preferences: SlidersHorizontal,
  organizations: Building2,
  project: FolderOpen,
  team: SquareUserRound,
  file: FileText,
} as const satisfies Record<string, LucideIcon>

/** Known breadcrumb / history labels → icon (covers titles that differ slightly). */
const LABEL_ICONS: Record<string, LucideIcon> = {
  "All organizations": NAV_PAGE_ICONS.organizations,
  Overview: NAV_PAGE_ICONS.overview,
  Projects: NAV_PAGE_ICONS.projects,
  Teams: NAV_PAGE_ICONS.teams,
  Team: NAV_PAGE_ICONS.team,
  "Assigned to me": NAV_PAGE_ICONS.assigned,
  Members: NAV_PAGE_ICONS.members,
  "Members matrix": NAV_PAGE_ICONS.members,
  Archived: NAV_PAGE_ICONS.archived,
  "Archived projects": NAV_PAGE_ICONS.archived,
  Settings: NAV_PAGE_ICONS.settings,
  "Organization settings": NAV_PAGE_ICONS.settings,
  "Project settings": NAV_PAGE_ICONS.settings,
  Admin: NAV_PAGE_ICONS.admin,
  "Admin console": NAV_PAGE_ICONS.admin,
  "Shared with you": NAV_PAGE_ICONS.shared,
  Preferences: NAV_PAGE_ICONS.preferences,
  Home: NAV_PAGE_ICONS.projects,
  Project: NAV_PAGE_ICONS.project,
  // Org settings sections (match OrgSettingsIndex).
  Identity: Building2,
  "Export permissions": Download,
  "Roster & progress visibility": EyeOff,
  "Assignment authority": UserCheck,
  "AI provider keys": KeyRound,
  "Monday.com": Workflow,
  // Project workspace surfaces.
  Editor: BookOpenText,
  File: FileText,
  "Checks & rules": SpellCheck,
  Agent: Bot,
  Voice: Mic,
  Terminology: Languages,
  Comments: MessageSquare,
  "Project memory": BrainCircuit,
  "Project overview": NAV_PAGE_ICONS.project,
}

export function navIconForLabel(label: string): LucideIcon | undefined {
  return LABEL_ICONS[label]
}

/** Resolve an icon from a route pathname (history entries, fallbacks). */
export function deriveNavIcon(pathname: string): LucideIcon {
  const p = pathname.replace(/\/+$/, "") || "/"
  if (p === "/") return NAV_PAGE_ICONS.projects

  switch (p) {
    case "/projects":
      return NAV_PAGE_ICONS.projects
    case "/preferences":
      return NAV_PAGE_ICONS.preferences
    case "/admin":
      return NAV_PAGE_ICONS.admin
    case "/shared":
      return NAV_PAGE_ICONS.shared
  }

  if (p.startsWith("/preferences/")) return NAV_PAGE_ICONS.preferences

  const org = parseOrgPath(p)
  if (org) {
    if (org.orgKey === ALL_ORGS_PARAM || org.rest === "") return NAV_PAGE_ICONS.projects
    const rest = org.rest.replace(/^\//, "")
    const parts = rest.split("/").filter(Boolean)
    switch (parts[0]) {
      case "overview":
        return NAV_PAGE_ICONS.overview
      case "projects":
        return NAV_PAGE_ICONS.projects
      case "archived":
        return NAV_PAGE_ICONS.archived
      case "assigned":
        return NAV_PAGE_ICONS.assigned
      case "settings":
        if (parts[1] === "identity") return Building2
        if (parts[1] === "export") return Download
        if (parts[1] === "roster") return EyeOff
        if (parts[1] === "assignment") return UserCheck
        if (parts[1] === "providers") return KeyRound
        if (parts[1] === "monday") return Workflow
        return NAV_PAGE_ICONS.settings
      case "members":
        return NAV_PAGE_ICONS.members
      case "teams":
        if (parts.includes("settings")) return NAV_PAGE_ICONS.settings
        return parts.length >= 2 ? NAV_PAGE_ICONS.team : NAV_PAGE_ICONS.teams
      default:
        break
    }
  }

  const seg = p.split("/").filter(Boolean)

  if (seg[0] === "projects" && seg.length === 2) return NAV_PAGE_ICONS.project

  if (seg[0] === "project" && seg.length >= 2) {
    switch (seg[2]) {
      case "editor":
        return seg[3] === "file" ? FileText : BookOpenText
      case "settings":
        return NAV_PAGE_ICONS.settings
      case "rules":
        return SpellCheck
      case "agent":
        return Bot
      case "voice":
        return Mic
      case "terminology":
        return Languages
      case "comments":
        return MessageSquare
      case "memory":
        return BrainCircuit
      default:
        return NAV_PAGE_ICONS.project
    }
  }

  return FileText
}
