type Listener = () => void

const listeners = new Map<string, Set<Listener>>()

function cellHistoryKey(projectId: string, fileId: string, cellId: string): string {
  return JSON.stringify([projectId, fileId, cellId])
}

/** Subscribe only while a history surface for this exact cell is open. */
export function subscribeToCellHistoryInvalidation(
  projectId: string,
  fileId: string,
  cellId: string,
  listener: Listener,
): () => void {
  const key = cellHistoryKey(projectId, fileId, cellId)
  let scoped = listeners.get(key)
  if (!scoped) {
    scoped = new Set()
    listeners.set(key, scoped)
  }
  scoped.add(listener)
  return () => {
    scoped?.delete(listener)
    if (scoped?.size === 0) listeners.delete(key)
  }
}

/** Called from exact event.applied WS frames after the server projection lands. */
export function invalidateCellHistory(
  projectId: string,
  fileId: string,
  cellId: string,
): void {
  const scoped = listeners.get(cellHistoryKey(projectId, fileId, cellId))
  if (!scoped) return
  for (const listener of scoped) listener()
}
