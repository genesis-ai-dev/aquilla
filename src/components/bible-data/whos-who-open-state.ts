// Who's Who panel (AQU-1689): whether it is open, per project, on this
// device. Like Verse Resources' open flag (VerseResourcesSidebar).

const OPEN_STORAGE_KEY_PREFIX = "aquilla:whos-who:"

function openStateKey(projectId: string): string {
  return `${OPEN_STORAGE_KEY_PREFIX}${projectId}:open`
}

export function readWhosWhoOpen(projectId: string): boolean {
  try {
    return window.localStorage.getItem(openStateKey(projectId)) === "true"
  } catch {
    return false
  }
}

export function writeWhosWhoOpen(projectId: string, value: boolean): void {
  try {
    window.localStorage.setItem(openStateKey(projectId), value ? "true" : "false")
  } catch {
    // localStorage may be unavailable — ignore
  }
}
