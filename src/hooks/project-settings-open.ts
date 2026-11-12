/**
 * AQU-1470: one `project settings hydrated` event per project open.
 *
 * The event measures how often the header shows real languages within 2s of
 * opening a project (docs/superpowers/specs/2026-04-29-project-settings-sync-design.md).
 * Every `useProjectSettings` instance fetches on its own, and focus / online /
 * settings-updated revalidation fetch again, so capturing on each successful GET
 * counted one open three or four times. This module holds the open at module
 * scope, shared by every instance in the tab, and lets the first successful
 * fetch of that open claim the report.
 *
 * An open lasts while any instance for the project is mounted. A page change
 * unmounts every instance and mounts new ones (ProjectWorkspace → ProjectOverview
 * are different components), and a lazy route can take a moment to load, so the
 * open survives a grace period after its last instance unmounts. Mounting again
 * within the grace period continues the same open; after it, the next mount is a
 * new open with a fresh start time.
 */

export const PROJECT_OPEN_LEAVE_GRACE_MS = 10_000

interface ProjectOpen {
  startedAt: number
  mounted: number
  reported: boolean
  leaveTimer: ReturnType<typeof setTimeout> | null
}

const opens = new Map<string, ProjectOpen>()

/**
 * Register a mounted settings consumer for `projectId`. Starts a new open when
 * none is live. Returns the release function for the effect cleanup.
 */
export function retainProjectOpen(projectId: string): () => void {
  let open = opens.get(projectId)
  if (!open) {
    open = { startedAt: performance.now(), mounted: 0, reported: false, leaveTimer: null }
    opens.set(projectId, open)
  }
  if (open.leaveTimer) {
    clearTimeout(open.leaveTimer)
    open.leaveTimer = null
  }
  open.mounted += 1
  const held = open
  return () => {
    held.mounted -= 1
    if (held.mounted > 0) return
    held.leaveTimer = setTimeout(() => {
      if (opens.get(projectId) === held && held.mounted === 0) opens.delete(projectId)
    }, PROJECT_OPEN_LEAVE_GRACE_MS)
  }
}

/**
 * Claim the hydration report for the live open of `projectId`. Returns the
 * milliseconds since the open started the first time it is called for an open,
 * and null on every later call (or when no open is live).
 */
export function claimHydrationReport(projectId: string): number | null {
  const open = opens.get(projectId)
  if (!open || open.reported) return null
  open.reported = true
  return Math.round(performance.now() - open.startedAt)
}
