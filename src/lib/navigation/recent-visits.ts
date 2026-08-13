/**
 * Memorable "previously viewed" destinations — concrete projects, teams, and
 * editor files; not org-shell list pages (Projects, Teams list, Assigned, …).
 */
import { parseOrgPath } from "@/lib/navigation/org-paths"

export type RecentKind = "project" | "team" | "file"

export interface RecentEntity {
  kind: RecentKind
  /** Stable dedupe key: project id, `orgId:groupId` for a team, or `projectId:fileId`. */
  id: string
  /** Path to open when the user picks this entry. */
  pathname: string
  search: string
  title: string
  timestamp: number
}

export const RECENT_KIND_LABEL: Record<RecentKind, string> = {
  project: "Project",
  team: "Team",
  file: "File",
}

export const MAX_RECENT_VISITS = 15

/** Identify a trackable entity visit from a pathname, or null to skip. */
export function parseRecentEntity(pathname: string): {
  kind: RecentKind
  id: string
  /** Preferred landing path for this entity (overview / team detail / file). */
  homePath: string
} | null {
  const p = pathname.replace(/\/+$/, "") || "/"
  const seg = p.split("/").filter(Boolean)

  // /projects/:id — project overview
  if (seg[0] === "projects" && seg.length >= 2 && seg[1]) {
    const projectId = seg[1]
    return { kind: "project", id: projectId, homePath: `/projects/${projectId}` }
  }

  // /project/:id/editor/file/:fileId — one entry per editor file
  if (
    seg[0] === "project" &&
    seg[1] &&
    seg[2] === "editor" &&
    seg[3] === "file" &&
    seg[4]
  ) {
    const projectId = seg[1]
    const fileId = seg[4]
    return {
      kind: "file",
      id: `${projectId}:${fileId}`,
      homePath: `/project/${projectId}/editor/file/${fileId}`,
    }
  }

  // /project/:id[/…] — other workspace surfaces collapse to one project entry
  if (seg[0] === "project" && seg.length >= 2 && seg[1]) {
    const projectId = seg[1]
    return { kind: "project", id: projectId, homePath: `/projects/${projectId}` }
  }

  const org = parseOrgPath(p)
  if (org && typeof org.orgKey === "number") {
    const parts = org.rest.replace(/^\//, "").split("/").filter(Boolean)
    // /orgs/:orgId/teams/:groupId[…] — not the teams list alone
    if (parts[0] === "teams" && parts[1] && /^\d+$/.test(parts[1])) {
      const groupId = parts[1]
      return {
        kind: "team",
        id: `${org.orgKey}:${groupId}`,
        homePath: `/orgs/${org.orgKey}/teams/${groupId}`,
      }
    }
  }

  return null
}

/** Provisional label until the real entity name loads via useNavHistoryTitle. */
export function recentProvisionalTitle(kind: RecentKind): string {
  return RECENT_KIND_LABEL[kind]
}

/**
 * Prefer the memorable name for recently-viewed: project/team keep the name
 * before " · "; files keep the part after (the file name).
 */
export function recentTitleFromNavTitle(kind: RecentKind, navTitle: string): string {
  const trimmed = navTitle.trim()
  if (!trimmed.includes(" · ")) return trimmed
  const [before, ...after] = trimmed.split(" · ")
  if (kind === "file") {
    const fileName = after.join(" · ").trim()
    return fileName || trimmed
  }
  return (before ?? trimmed).trim() || trimmed
}

/** Upsert a visit to the front of the recent list (newest first), capped. */
export function upsertRecentVisit(
  recent: RecentEntity[],
  visit: Omit<RecentEntity, "timestamp"> & { timestamp?: number },
): RecentEntity[] {
  const next: RecentEntity = {
    ...visit,
    timestamp: visit.timestamp ?? Date.now(),
  }
  const without = recent.filter((e) => !(e.kind === next.kind && e.id === next.id))
  return [next, ...without].slice(0, MAX_RECENT_VISITS)
}

/** Upgrade the title of a matching recent entity (by kind+id). */
export function renameRecentVisit(
  recent: RecentEntity[],
  kind: RecentKind,
  id: string,
  title: string,
): RecentEntity[] {
  const trimmed = title.trim()
  if (!trimmed) return recent
  let changed = false
  const next = recent.map((e) => {
    if (e.kind !== kind || e.id !== id || e.title === trimmed) return e
    changed = true
    return { ...e, title: trimmed }
  })
  return changed ? next : recent
}
