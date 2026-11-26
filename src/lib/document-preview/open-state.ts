// Document preview panel: whether it is open, per project, on this device.
// Stored like the Who's Who panel's open flag (whos-who-open-state.ts), and
// read through a hook so the workspace holds no state of its own for it
// (AQU-2654).

import { useSyncExternalStore } from "react"

const OPEN_STORAGE_KEY_PREFIX = "aquilla:document-preview:"

const listeners = new Set<() => void>()

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
    // localStorage may be unavailable — the panel then cannot be opened.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether this project's preview panel is open. False without a project. */
export function useDocumentPreviewOpen(projectId: string | null | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (projectId ? readDocumentPreviewOpen(projectId) : false),
    () => false,
  )
}
