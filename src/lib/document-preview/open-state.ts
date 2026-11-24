// Document preview panel: whether it is open, per project, on this device.
// Like the Who's Who panel's open flag (whos-who-open-state.ts).

const OPEN_STORAGE_KEY_PREFIX = "aquilla:document-preview:"

function openStateKey(projectId: string): string {
  return `${OPEN_STORAGE_KEY_PREFIX}${projectId}:open`
}

export function readDocumentPreviewOpen(projectId: string): boolean {
  try {
    return window.localStorage.getItem(openStateKey(projectId)) === "true"
  } catch {
    return false
  }
}

export function writeDocumentPreviewOpen(projectId: string, value: boolean): void {
  try {
    window.localStorage.setItem(openStateKey(projectId), value ? "true" : "false")
  } catch {
    // localStorage may be unavailable — ignore
  }
}
