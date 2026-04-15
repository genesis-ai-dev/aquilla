import { useEffect, useRef } from "react"
import { isProjectDirty } from "@/lib/sync/dirty"
import { syncProject } from "@/lib/sync/git-sync"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"

/**
 * Interval-driven auto-sync. Checks `isProjectDirty` first, skips if a sync is
 * already in flight, and only runs when `project.syncSettings.autoSync.enabled`
 * is true. Interval is floored at 1 minute.
 */
export function useAutoSync(
  project: ProjectRecord | null,
  session: FrontierSession | null,
): void {
  const inFlightRef = useRef(false)

  useEffect(() => {
    if (!project || !session) return
    if (project.origin?.kind !== "git") return
    const settings = project.syncSettings?.autoSync
    if (!settings?.enabled) return
    const ms = Math.max(60_000, settings.intervalMinutes * 60_000)

    const id = window.setInterval(async () => {
      if (inFlightRef.current) return
      try {
        const dirty = await isProjectDirty(project)
        if (!dirty) return
        inFlightRef.current = true
        await syncProject(project, session)
      } catch {
        // Auto-sync errors are swallowed here; manual sync surfaces details.
      } finally {
        inFlightRef.current = false
      }
    }, ms)

    return () => window.clearInterval(id)
  }, [project, session])
}
