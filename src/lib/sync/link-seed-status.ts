// AQU-1544 — which projects have a saved live link whose first mirror sync is
// known, this session, to have failed.
//
// Linking is two steps: the link row is saved, then the upstream's files are
// brought in by a first mirror sync. Until this slice every caller treated the
// second step's failure as success, so the user was left on a project marked
// linked with none of the upstream's files and nothing on screen saying so.
//
// The failure is learned in one place (the link flow, the create dialog, or the
// workspace's zero-file self-heal) and has to be SHOWN in another: the create
// dialog closes and navigates to the project it made, and the Import dialog can
// be dismissed back to the workspace. A link flow's own state dies with the
// component, so the fact is parked here, keyed by project id, for the surface
// the user lands on (`LinkSeedFailedBanner`).
//
// Deliberately in-memory and session-scoped. This is "we tried and it did not
// work", not the durable truth — that is `projects.source_link_cursor`, which
// Project Settings reads to show a never-synced link after a reload. A reload
// forgets the entries here and the workspace's self-heal re-learns them.

const failedProjectIds = new Set<string>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Record that `projectId`'s link is saved but its first sync did not land. */
export function markLinkSeedFailed(projectId: string): void {
  if (failedProjectIds.has(projectId)) return
  failedProjectIds.add(projectId)
  notify()
}

/** A later sync succeeded — the upstream's files are in. */
export function clearLinkSeedFailed(projectId: string): void {
  if (!failedProjectIds.delete(projectId)) return
  notify()
}

export function isLinkSeedFailed(projectId: string): boolean {
  return failedProjectIds.has(projectId)
}

export function subscribeLinkSeedStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only: module state would otherwise leak between cases. */
export function resetLinkSeedStatusForTests(): void {
  failedProjectIds.clear()
  notify()
}
