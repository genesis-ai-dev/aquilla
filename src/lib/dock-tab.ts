/**
 * Last-open left-dock tab (Files / Voices / Agent / Search).
 *
 * Per-project chrome preference — same threat model as editor-lens: localStorage
 * only, never synced. Collapsed (`null`) is not stored; we remember the last
 * actual tab so reload and expand reopen that surface.
 */

export const DOCK_TABS = ["files", "voices", "agent", "search"] as const
export type DockTab = (typeof DOCK_TABS)[number]

const STORAGE_PREFIX = "aquilla:dockTab:"
const DEFAULT_TAB: DockTab = "files"

function storageKey(projectId: string): string {
  return `${STORAGE_PREFIX}${projectId}`
}

export function isDockTab(value: string | null): value is DockTab {
  return value === "files" || value === "voices" || value === "agent" || value === "search"
}

export function readLastDockTab(projectId: string): DockTab {
  if (!projectId || typeof window === "undefined") return DEFAULT_TAB
  try {
    const raw = window.localStorage.getItem(storageKey(projectId))
    return isDockTab(raw) ? raw : DEFAULT_TAB
  } catch {
    return DEFAULT_TAB
  }
}

export function writeLastDockTab(projectId: string, tab: DockTab): void {
  if (!projectId || typeof window === "undefined") return
  try {
    window.localStorage.setItem(storageKey(projectId), tab)
  } catch {
    // quota / private mode — in-memory tab still updates
  }
}
