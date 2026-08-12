/**
 * Org-scoped URL helpers.
 *
 * Org context lives in the path (`/orgs/$orgId/...` or `/orgs/all`).
 * localStorage (`org:active`) only resumes `/` → last org.
 */

export const ORG_STORAGE_KEY = "org:active"
export const ALL_ORGS_PARAM = "all"

/** Match `/orgs/:orgKey` and optional rest (`/members`, `/settings/identity`, …). */
const ORG_PATH_RE = /^\/orgs\/([^/]+)(\/.*)?$/

export type OrgPathKey = number | typeof ALL_ORGS_PARAM

export function orgKeyFromParam(raw: string | undefined): OrgPathKey | null {
  if (raw == null || raw === "") return null
  if (raw === ALL_ORGS_PARAM) return ALL_ORGS_PARAM
  const id = Number(raw)
  if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) return null
  return id
}

/** Parse org key + remainder from a pathname, or null if not under `/orgs/...`. */
export function parseOrgPath(pathname: string): { orgKey: OrgPathKey; rest: string } | null {
  const m = pathname.match(ORG_PATH_RE)
  if (!m) return null
  const orgKey = orgKeyFromParam(m[1])
  if (orgKey == null) return null
  return { orgKey, rest: m[2] ?? "" }
}

export function orgHomePath(orgKey: OrgPathKey): string {
  return `/orgs/${orgKey}`
}

/** Member-org default landing — stats + rollups (not the project table). */
export function orgOverviewPath(orgId: number): string {
  return orgPath(orgId, "/overview")
}

/** Teams-style project list for a concrete org. */
export function orgProjectsPath(orgId: number): string {
  return orgPath(orgId, "/projects")
}

export function orgPath(orgKey: OrgPathKey, rest = ""): string {
  const suffix = rest.startsWith("/") ? rest : rest ? `/${rest}` : ""
  // `/orgs/all` is home-only — never attach nested tools.
  if (orgKey === ALL_ORGS_PARAM) return orgHomePath(ALL_ORGS_PARAM)
  return `${orgHomePath(orgKey)}${suffix}`
}

/**
 * When switching orgs, keep the current tool path when both sides are concrete
 * orgs. Switching to "all" always lands on the portfolio home.
 */
export function swapOrgInPath(pathname: string, nextOrgKey: OrgPathKey): string {
  const parsed = parseOrgPath(pathname)
  if (nextOrgKey === ALL_ORGS_PARAM) return orgHomePath(ALL_ORGS_PARAM)
  if (!parsed || parsed.orgKey === ALL_ORGS_PARAM) return orgHomePath(nextOrgKey)
  return orgPath(nextOrgKey, parsed.rest)
}

/** Resume target for `/` — last org from localStorage, else `/orgs/all`. */
export function resumeOrgPath(): string {
  if (typeof window === "undefined") return orgHomePath(ALL_ORGS_PARAM)
  try {
    const raw = window.localStorage.getItem(ORG_STORAGE_KEY)
    if (!raw || raw === ALL_ORGS_PARAM) return orgHomePath(ALL_ORGS_PARAM)
    const id = Number(raw)
    if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) {
      return orgHomePath(ALL_ORGS_PARAM)
    }
    return orgHomePath(id)
  } catch {
    return orgHomePath(ALL_ORGS_PARAM)
  }
}

export function membersPath(orgId: number, tab: "roster" | "matrix" = "roster"): string {
  return tab === "matrix" ? orgPath(orgId, "/members/matrix") : orgPath(orgId, "/members")
}

export function orgSettingsPath(orgId: number, section?: string): string {
  return section ? orgPath(orgId, `/settings/${section}`) : orgPath(orgId, "/settings")
}

export function teamSettingsPath(orgId: number, groupId: number | string, section?: string): string {
  const base = `/teams/${groupId}/settings`
  return section ? orgPath(orgId, `${base}/${section}`) : orgPath(orgId, base)
}

export function projectSettingsPath(projectId: string, section?: string): string {
  return section
    ? `/project/${projectId}/settings/${section}`
    : `/project/${projectId}/settings`
}

/** Default work surface — paired cell editor (`/project/$id/editor`). */
export function projectEditorPath(projectId: string, fileId?: string | null): string {
  const base = `/project/${projectId}/editor`
  return fileId ? `${base}/file/${fileId}` : base
}

/** Same-origin relative path from `?return=` — rejects protocol-relative URLs. */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null
  return raw
}

/** True when `path` is this project's editor (`/project/:id/editor` or a file under it). */
export function isProjectEditorPath(path: string, projectId: string): boolean {
  const base = projectEditorPath(projectId)
  return path === base || path.startsWith(`${base}/`)
}

/** Keep the editor handoff (`?return=`) on a path so the Editor crumb survives hops. Merges into any existing query. */
export function withEditorReturn(path: string, returnTo: string | null | undefined): string {
  if (!returnTo) return path
  const qIndex = path.indexOf("?")
  const pathname = qIndex === -1 ? path : path.slice(0, qIndex)
  const params = new URLSearchParams(qIndex === -1 ? "" : path.slice(qIndex + 1))
  params.set("return", returnTo)
  return `${pathname}?${params.toString()}`
}

/** Keep the editor handoff (`?return=`) on in-settings links so the Editor crumb survives pane hops. */
export function withSettingsReturn(path: string, returnTo: string | null | undefined): string {
  return withEditorReturn(path, returnTo)
}

/** Current editor URL, or `?return=` when it points at this project's editor. */
export function editorReturnFromLocation(
  pathname: string,
  search: string,
  projectId: string,
): string | null {
  if (isProjectEditorPath(pathname, projectId)) return pathname
  const raw = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("return")
  const returnTo = safeReturnPath(raw)
  return returnTo && isProjectEditorPath(returnTo, projectId) ? returnTo : null
}
