// AQU-1938: the projects behind the "N projects …" counts on the org settings
// pages (Project defaults, Security). Pure types and parsing, kept out of
// org-settings.ts so the hooks that read them do not depend on the network
// module many tests replace wholesale.

/** The org defaults a project may set its own value for (Project defaults). */
export type InheritedOverrideKey = "countStructuralCells" | "validationCount" | "validationCountAudio"

/**
 * The projects behind one count. `projects` holds at most 50 (by name), and
 * only the ones the caller may see; `total` is every project the count covers,
 * so the count minus the names shown is the "and N more".
 */
export interface OverrideProjectList {
  total: number
  projects: Array<{ id: string; name: string }>
}

/**
 * Read one list off a server response, or null when it is missing or not the
 * expected shape (an older server, a proxy that mangled it). Null keeps the
 * line to its bare count rather than showing a half-read list.
 */
export function parseOverrideProjectList(raw: unknown): OverrideProjectList | null {
  if (!raw || typeof raw !== "object") return null
  const { total, projects } = raw as { total?: unknown; projects?: unknown }
  if (typeof total !== "number" || !Number.isFinite(total) || !Array.isArray(projects)) return null
  const named = projects
    .filter(
      (p): p is { id: string; name: string } =>
        !!p && typeof p === "object"
        && typeof (p as { id?: unknown }).id === "string"
        && typeof (p as { name?: unknown }).name === "string",
    )
    .map(({ id, name }) => ({ id, name }))
  return { total, projects: named }
}
