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
