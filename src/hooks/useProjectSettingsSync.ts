// Cross-collaborator sync for project-level settings (AI provider,
// instructions). Hitches a ride on whatever file Y.Doc is currently open:
// the doc's `meta` map is the only project-scoped channel that already
// flows through the sync-worker. As soon as either user has a file open
// changes propagate; a dedicated project-meta room is the cleaner long-
// term fix and is tracked separately.
//
// Per-user fields like `setupChecklistDismissed` are intentionally NOT
// synced — each collaborator decides when to hide their own checklist.

import { useEffect, useRef } from "react"
import * as Y from "yjs"
import type { CompletionSettings, ProjectRecord } from "@/lib/parsers/types"
import { patchProject } from "@/lib/store/project-index"

const META_KEY = "__projectSettings"

interface ProjectSettingsPayload {
  completionSettings?: CompletionSettings
  /** ISO timestamp; future-proofing for last-write-wins reconciliation. */
  updatedAt?: string
}

function settingsEqual(
  a: CompletionSettings | undefined,
  b: CompletionSettings | undefined,
): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Two-way reconcile project settings between local IDB and the active
 * file Y.Doc's meta map.
 *
 *   • On mount / doc swap: read meta. If meta lacks settings but local has
 *     them, push local → meta (we're the source of truth on first open).
 *     If meta has newer/different settings, pull meta → IDB and refresh.
 *   • Subscribe to meta changes: any future write by another client triggers
 *     reconcile.
 *   • When local settings change (e.g. user saves AI provider), push to meta.
 */
export function useProjectSettingsSync(
  doc: Y.Doc | null,
  project: ProjectRecord | null,
  refresh: () => void,
): void {
  // Latest local settings, kept in a ref so the observer always sees the
  // current value without needing to be re-subscribed on every save.
  const localRef = useRef<CompletionSettings | undefined>(project?.completionSettings)
  useEffect(() => {
    localRef.current = project?.completionSettings
  }, [project?.completionSettings])

  // --- Inbound: meta → IDB. Reconcile once on mount and on every change. ---
  useEffect(() => {
    if (!doc || !project) return
    const meta = doc.getMap("meta")

    async function reconcileFromMeta() {
      const remote = meta.get(META_KEY) as ProjectSettingsPayload | undefined
      if (!remote?.completionSettings) return
      if (settingsEqual(localRef.current, remote.completionSettings)) return
      // Use patchProject to avoid clobbering concurrent writes to other
      // fields. Refresh so the in-memory project gets the new settings.
      await patchProject(project!.id, (p) => ({
        ...p,
        completionSettings: remote.completionSettings,
      }))
      refresh()
    }

    void reconcileFromMeta()

    const observer = (event: Y.YMapEvent<unknown>) => {
      if (!event.keysChanged.has(META_KEY)) return
      void reconcileFromMeta()
    }
    meta.observe(observer)
    return () => meta.unobserve(observer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, project?.id])

  // --- Outbound: IDB → meta. When local settings change, mirror to doc. ---
  useEffect(() => {
    if (!doc) return
    const settings = project?.completionSettings
    if (!settings) return
    const meta = doc.getMap("meta")
    const current = meta.get(META_KEY) as ProjectSettingsPayload | undefined
    if (settingsEqual(current?.completionSettings, settings)) return
    doc.transact(() => {
      meta.set(META_KEY, {
        completionSettings: settings,
        updatedAt: new Date().toISOString(),
      })
    })
  }, [doc, project?.completionSettings])
}
