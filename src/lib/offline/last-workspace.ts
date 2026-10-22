// Desktop: the editor route a user last had open, so launching the app with no
// connection reopens it instead of stopping on an org page that can't load.
//
// Per user and per device (localStorage) — a convenience, not data: losing it
// just means landing on the org page as before. Only consulted offline, and
// only for a project whose download is ready (OfflineLaunchResume).

export interface LastWorkspace {
  projectId: string
  path: string
}

const storageKey = (username: string) => `aquilla.offline.lastWorkspace.${username}`

export function rememberLastWorkspace(username: string, workspace: LastWorkspace): void {
  try {
    localStorage.setItem(storageKey(username), JSON.stringify(workspace))
  } catch {
    /* storage unavailable — nothing to resume next launch */
  }
}

export function readLastWorkspace(username: string): LastWorkspace | null {
  try {
    const raw = localStorage.getItem(storageKey(username))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LastWorkspace> | null
    if (typeof parsed?.projectId !== "string" || typeof parsed.path !== "string") return null
    // Only ever a route inside that project — never somewhere else in the app.
    if (!parsed.path.startsWith(`/project/${parsed.projectId}/`)) return null
    return { projectId: parsed.projectId, path: parsed.path }
  } catch {
    return null
  }
}

/** Where a launch lands before anything is opened: `/`, then the org home. */
export function isLaunchLandingPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/orgs" || pathname.startsWith("/orgs/")
}
