// "This project's settings row is being, or has just been, written."
//
// Raised by every client-side writer (`patchProjectSettings`) and by every
// announcement of a write made elsewhere (`broadcastProjectSettingsUpdated`).
// The shared settings read (project-settings-shared-read.ts) listens, so an
// answer read before the write is never kept to hydrate a later mount.
//
// Its own module, with no imports, so the writer and the reader can both use
// it without importing each other.

type Listener = (projectId: string) => void

const listeners = new Set<Listener>()

export function noteProjectSettingsWrite(projectId: string): void {
  for (const listener of listeners) listener(projectId)
}

export function onProjectSettingsWrite(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
