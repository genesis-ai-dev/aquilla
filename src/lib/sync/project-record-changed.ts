// AQU-1570 — "this project's record changed on the server; re-read it".
//
// Project Settings opens as a route modal OVER the still-mounted workspace or
// project overview (App.tsx `backgroundLocation`), and each of those surfaces
// resolves the project through its own `useProject` instance. A change made
// inside the dialog refreshed only the dialog's copy: linking a source project
// brought the upstream's files in, and the page behind kept its old file list
// until a reload. Nothing else would have told it — the mirror sync's writes are
// not broadcast on the project socket (AQU-1545).
//
// The surface that made the change announces it here, once the server has it;
// every mounted `useProject` for that project re-resolves. Tab-scoped and
// in-memory on purpose: it carries no data, only "go and look", so another tab
// or a teammate converges the way it always has (its own load, or the socket).

type ProjectRecordChangedListener = (projectId: string) => void

const listeners = new Set<ProjectRecordChangedListener>()

/** Tell every surface in this tab that shows `projectId` to re-read it. */
export function announceProjectRecordChanged(projectId: string): void {
  // Copied first: a listener's re-render may unsubscribe and resubscribe.
  for (const listener of [...listeners]) listener(projectId)
}

export function subscribeProjectRecordChanged(listener: ProjectRecordChangedListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
