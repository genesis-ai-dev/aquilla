/**
 * pending-import — the Aquilla project "Open project" created for a Paratext
 * project folder whose import has not finished yet.
 *
 * "Open project" creates the Aquilla project before the user picks a source
 * Bible, because the import needs a project to write into. A user who leaves
 * at that step and opens the project again must get the same Aquilla project,
 * not a second empty one. The mirror link (bridge store) replaces this record
 * once the import has run.
 *
 * Key schema: `aq.paratext-pending-import.v1:{stateId}` → JSON
 * `{ projectId, targetLang }`. Device-scoped, like the mirror link.
 */

import type { BridgeStateId } from "./project"

const PREFIX = "aq.paratext-pending-import.v1:"

export interface PendingImport {
  projectId: string
  /** Target lane tag the project was created with (`''` = default lane). */
  targetLang: string
}

export function getPendingImport(id: BridgeStateId): PendingImport | null {
  try {
    const raw = localStorage.getItem(PREFIX + id)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<PendingImport>
    return typeof v.projectId === "string" ? { projectId: v.projectId, targetLang: typeof v.targetLang === "string" ? v.targetLang : "" } : null
  } catch {
    return null
  }
}

export function setPendingImport(id: BridgeStateId, pending: PendingImport): void {
  try { localStorage.setItem(PREFIX + id, JSON.stringify(pending)) } catch { /* storage unavailable: a retry makes a new project */ }
}

export function clearPendingImport(id: BridgeStateId): void {
  try { localStorage.removeItem(PREFIX + id) } catch { /* nothing to clear */ }
}

/** Test helper: drop every pending record. */
export function resetPendingParatextImportsForTests(): void {
  for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key)
}
