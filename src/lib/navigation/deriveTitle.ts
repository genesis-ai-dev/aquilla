/**
 * deriveTitle — map a route pathname to a human-readable label for the
 * client-side back/forward history popover.
 *
 * This produces a *provisional* label from the URL alone (no data lookups),
 * so every history entry has a sensible name immediately. Pages that know a
 * richer name (e.g. the project + file name) upgrade their entry's title via
 * `useNavHistoryTitle` once that data has loaded.
 *
 * `src/lib/` can't call the `useT()` hook, so this module stays pure and
 * returns a `NavTitle` descriptor — either a catalog `key` a component
 * resolves with `t()`, or `raw` text that isn't a translatable UI string (the
 * title-cased last URL segment; a value read verbatim from
 * `ORG_SETTINGS_SECTION_TITLES`, which is its own untranslated English source
 * outside this module's scope). `deriveNavTitle` is a back-compat wrapper
 * that resolves a `key` against the English base catalog directly — it does
 * NOT localize, it only removes the second, independent copy of these
 * strings this file used to hard-code. It exists because one call site
 * (`ProjectWorkspace.tsx`) branches on the literal return value (`section ===
 * "Editor"`) and isn't in scope to migrate here; `useNavHistoryTitle` callers
 * should prefer `deriveNavTitleKey` + `useT()` for real localization.
 */
import { ORG_SETTINGS_SECTION_TITLES, type OrgSettingsSection } from "@/pages/settings/constants"
import { parseOrgPath, ALL_ORGS_PARAM } from "@/lib/navigation/org-paths"
import { translate } from "@/lib/i18n/translate"
import type { MessageKey } from "@/lib/i18n/messages/en"

export type NavTitle =
  | { kind: "key"; key: MessageKey }
  | { kind: "raw"; text: string }

function key(k: MessageKey): NavTitle {
  return { kind: "key", key: k }
}
function raw(text: string): NavTitle {
  return { kind: "raw", text }
}

export function deriveNavTitleKey(pathname: string): NavTitle {
  const p = pathname.replace(/\/+$/, "") || "/"
  if (p === "/") return key("editor.navTitle.home")

  // Global (non-org-prefixed) pages.
  switch (p) {
    case "/projects":
      return key("nav.projects")
    case "/preferences":
      return key("nav.account.preferences")
    case "/admin":
      return key("editor.navTitle.adminConsole")
    case "/shared":
      return key("editor.navTitle.sharedWithYou")
  }

  const org = parseOrgPath(p)
  if (org) {
    if (org.orgKey === ALL_ORGS_PARAM || org.rest === "") return key("nav.projects")
    const rest = org.rest.replace(/^\//, "")
    const parts = rest.split("/").filter(Boolean)
    switch (parts[0]) {
      case "archived":
        return key("editor.navTitle.archivedProjects")
      case "assigned":
        return key("editor.navTitle.assignedToMe")
      case "settings": {
        if (parts.length === 1) return key("editor.navTitle.organizationSettings")
        // These titles come from a separate, still-unkeyed English source
        // (src/pages/settings/constants.ts) outside this module's scope —
        // passed through as raw text rather than mis-keyed here.
        const sectionTitle = ORG_SETTINGS_SECTION_TITLES[parts[1] as OrgSettingsSection]
        return sectionTitle ? raw(sectionTitle) : key("nav.settings")
      }
      case "members":
        return parts[1] === "matrix" ? key("editor.navTitle.membersMatrix") : key("editor.navTitle.members")
      case "teams":
        return parts.length >= 2 ? key("editor.navTitle.team") : key("editor.navTitle.teams")
      default:
        break
    }
  }

  const seg = p.split("/").filter(Boolean)

  // /preferences/:section
  if (seg[0] === "preferences" && seg.length === 2) return key("nav.account.preferences")

  // /projects/:id — single project card view.
  if (seg[0] === "projects" && seg.length === 2) return key("editor.navTitle.projectOverview")

  // /project/:id[/<surface>] — workspace shell and its content surfaces.
  if (seg[0] === "project" && seg.length >= 2) {
    switch (seg[2]) {
      case "editor":
        return seg[3] === "file" ? key("common.file") : key("editor.navTitle.editor")
      case "settings":
        return key("editor.navTitle.projectSettings")
      case "rules":
        return key("editor.navTitle.checksAndRules")
      case "agent":
        return key("nav.dock.agentTab")
      case "voice":
        return key("editor.navTitle.voice")
      case "terminology":
        return key("nav.sidebarSection.terminology")
      case "comments":
        return key("common.comments")
      case "memory":
        return key("editor.navTitle.projectMemory")
      case "members":
        return key("editor.navTitle.projectMembers")
      default:
        return key("common.project")
    }
  }

  // Fallback — title-case the last segment. This is an arbitrary URL
  // segment, not app copy, so there's nothing to key: raw is correct.
  const last = seg[seg.length - 1] ?? "Page"
  return raw(last.charAt(0).toUpperCase() + last.slice(1))
}

/**
 * Back-compat English-only resolver — see the module doc comment. Prefer
 * `deriveNavTitleKey` + `useT()` in any new or migratable call site.
 */
export function deriveNavTitle(pathname: string): string {
  const info = deriveNavTitleKey(pathname)
  return info.kind === "key" ? translate(undefined, info.key) : info.text
}
