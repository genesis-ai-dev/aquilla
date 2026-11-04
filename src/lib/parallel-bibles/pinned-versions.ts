// Which Bible versions the Parallel Bibles panel shows.
//
// Two sources, in order:
//   1. The translator's own pins for THIS project (localStorage, per device).
//      Absent means "no pins of my own"; a stored list — even an empty one —
//      is a choice and wins.
//   2. The project's defaults, set by a project lead
//      (`ProjectWideSettings.parallelBibleVersions`).
//
// Pins used to be one global list for every project. The first read for a
// project with no list of its own copies a non-empty global list across, so a
// translator keeps what they had pinned. The global key is left in place: the
// next project they open copies it too.

export const LEGACY_VERSIONS_STORAGE_KEY = "aquilla:parallel-bibles:versions"

export function projectVersionsStorageKey(projectId: string): string {
  return `aquilla:parallel-bibles:${projectId}:versions`
}

function parseIds(raw: string | null): string[] | null {
  if (raw == null) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    return parsed.filter((v): v is string => typeof v === "string")
  } catch {
    return null
  }
}

function getItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function setItem(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // localStorage may be unavailable — the pins then last for this session.
  }
}

/**
 * The translator's own pins for a project, or null when they have none.
 * Without a project id (a caller outside a project) the global list is read.
 */
export function readPersonalPins(projectId?: string | null): string[] | null {
  const legacy = parseIds(getItem(LEGACY_VERSIONS_STORAGE_KEY))
  if (!projectId) return legacy && legacy.length > 0 ? legacy : null
  const own = parseIds(getItem(projectVersionsStorageKey(projectId)))
  if (own) return own
  if (legacy && legacy.length > 0) {
    setItem(projectVersionsStorageKey(projectId), JSON.stringify(legacy))
    return legacy
  }
  return null
}

/** Same-tab change signal: the editor's Bible columns and the Parallel Bibles
 *  panel read the same pins and must not drift apart. */
export const PINS_CHANGED_EVENT = "aquilla:parallel-bibles-pins"

function announce(projectId: string | null | undefined): void {
  try {
    window.dispatchEvent(new CustomEvent(PINS_CHANGED_EVENT, { detail: { projectId: projectId ?? null } }))
  } catch {
    // no window (tests without a DOM) — nothing to tell
  }
}

export function writePersonalPins(projectId: string | null | undefined, ids: readonly string[]): void {
  setItem(projectId ? projectVersionsStorageKey(projectId) : LEGACY_VERSIONS_STORAGE_KEY, JSON.stringify(ids))
  announce(projectId)
}

/** Drop this project's own pins, so the panel follows the project defaults. */
export function clearPersonalPins(projectId: string): void {
  try {
    window.localStorage.removeItem(projectVersionsStorageKey(projectId))
  } catch {
    // ignore
  }
  announce(projectId)
}

export type PinSource = "personal" | "project" | "none"

export interface ResolvedPins {
  ids: string[]
  source: PinSource
}

export function resolvePinnedVersions(
  personal: readonly string[] | null,
  projectDefaults: readonly string[] | null | undefined,
): ResolvedPins {
  if (personal) return { ids: [...personal], source: "personal" }
  if (projectDefaults && projectDefaults.length > 0) return { ids: [...projectDefaults], source: "project" }
  return { ids: [], source: "none" }
}

export function sameVersionList(a: readonly string[], b: readonly string[] | null | undefined): boolean {
  return !!b && a.length === b.length && a.every((id, i) => id === b[i])
}
