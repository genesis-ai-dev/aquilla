import type { ProjectRecord, FileReference } from "@/lib/parsers/types"

function replaceFile(
  project: ProjectRecord,
  fileId: string,
  update: (f: FileReference) => FileReference,
): ProjectRecord {
  const idx = project.files.findIndex((f) => f.id === fileId)
  if (idx < 0) throw new Error(`File ${fileId} not found in project`)
  const nextFiles = project.files.slice()
  nextFiles[idx] = update(project.files[idx])
  return { ...project, files: nextFiles }
}

export function renameFile(
  project: ProjectRecord, fileId: string, newName: string,
): ProjectRecord {
  const trimmed = newName.trim()
  if (!trimmed) throw new Error("File name cannot be empty")
  const existing = project.files.find((f) => f.id === fileId)
  if (!existing) throw new Error(`File ${fileId} not found in project`)
  if (existing.name === trimmed) return project
  const collision = project.files.some((f) => f.id !== fileId && f.name === trimmed)
  if (collision) throw new Error(`A file named "${trimmed}" already exists in this project`)
  return replaceFile(project, fileId, (f) => ({
    ...f,
    name: trimmed,
    originalName: f.originalName ?? f.name,
  }))
}

export function moveFileToCorpus(
  project: ProjectRecord, fileId: string, corpus: string,
): ProjectRecord {
  const trimmed = corpus.trim()
  return replaceFile(project, fileId, (f) => ({
    ...f,
    corpusMarker: trimmed || undefined,
  }))
}

export function renameCorpus(
  project: ProjectRecord, oldMarker: string, newMarker: string,
): ProjectRecord {
  const trimmedNew = newMarker.trim()
  const nextFiles = project.files.map((f) =>
    f.corpusMarker === oldMarker ? { ...f, corpusMarker: trimmedNew || undefined } : f
  )
  return { ...project, files: nextFiles }
}

/**
 * AQU-1569: apply a batch of hand-placed positions optimistically, so the
 * sidebar shows the new order on drop rather than on the next server read.
 * `null` clears a file's position (the "Reset order" action).
 *
 * Unlike the single-file helpers above this does NOT throw on an id it cannot
 * find: the writes come from `planFileMove` over a group the sidebar rendered,
 * and a file deleted in another tab between the render and the drop is a race
 * to ignore, not a reason to lose the rest of the batch.
 */
export function applyFileSortIndexes(
  project: ProjectRecord,
  writes: ReadonlyArray<{ fileId: string; sortIndex: number | null }>,
): ProjectRecord {
  if (writes.length === 0) return project
  const nextFiles = overlayPendingSortIndexes(project.files, new Map(writes.map((w) => [w.fileId, w.sortIndex])))
  if (nextFiles === project.files) return project
  return { ...project, files: nextFiles }
}

function finiteSortIndex(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * The order the sidebar should show while a drop's `file.reorder` events are
 * still on their way to the server. The list the user is looking at is the
 * server read; the IDB patch from `applyFileSortIndexes` does not reach it.
 * Without this overlay the row slides back to its old slot the moment the
 * pointer lets go.
 *
 * `null` clears a position (Reset order). An empty pending map returns the
 * same array.
 */
export function overlayPendingSortIndexes<T extends { id: string; sortIndex?: number }>(
  files: readonly T[],
  pending: ReadonlyMap<string, number | null>,
): T[] {
  if (pending.size === 0) return files as T[]
  let changed = false
  const next = files.map((file) => {
    if (!pending.has(file.id)) return file
    const sortIndex = pending.get(file.id)
    if (sortIndex === null || sortIndex === undefined) {
      if (file.sortIndex === undefined) return file
      changed = true
      const { sortIndex: _dropped, ...rest } = file
      return rest as T
    }
    if (file.sortIndex === sortIndex) return file
    changed = true
    return { ...file, sortIndex }
  })
  return changed ? next : (files as T[])
}

/**
 * The corpus a drop should show while its `file.corpus.set` is still on the
 * way. Same reason as `overlayPendingSortIndexes`: the list on screen is the
 * server read, so without this the file is back in its old corpus the moment
 * the pointer lets go.
 */
export function overlayPendingCorpusMarkers<T extends { id: string; corpusMarker?: string }>(
  files: readonly T[],
  pending: ReadonlyMap<string, string>,
): T[] {
  if (pending.size === 0) return files as T[]
  let changed = false
  const next = files.map((file) => {
    if (!pending.has(file.id)) return file
    const corpusMarker = pending.get(file.id)
    if (!corpusMarker || file.corpusMarker === corpusMarker) return file
    changed = true
    return { ...file, corpusMarker }
  })
  return changed ? next : (files as T[])
}

/**
 * Drop a pending corpus once the server read carries it. Returns the same
 * map when nothing has landed yet.
 */
export function settlePendingCorpusMarkers(
  files: readonly { id: string; corpusMarker?: string }[],
  pending: ReadonlyMap<string, string>,
): Map<string, string> {
  if (pending.size === 0) return pending as Map<string, string>
  let changed = false
  const next = new Map(pending)
  for (const file of files) {
    const wanted = next.get(file.id)
    if (wanted !== undefined && file.corpusMarker === wanted) {
      next.delete(file.id)
      changed = true
    }
  }
  return changed ? next : (pending as Map<string, string>)
}

/**
 * Drop pending positions the server read has caught up with. Returns the same
 * map when nothing has landed yet, so a render can bail out.
 */
export function settlePendingSortIndexes(
  files: readonly { id: string; sortIndex?: number }[],
  pending: ReadonlyMap<string, number | null>,
): Map<string, number | null> {
  if (pending.size === 0) return pending as Map<string, number | null>
  let changed = false
  const next = new Map(pending)
  for (const file of files) {
    if (!next.has(file.id)) continue
    const wanted = finiteSortIndex(next.get(file.id) ?? undefined)
    if (wanted === finiteSortIndex(file.sortIndex)) {
      next.delete(file.id)
      changed = true
    }
  }
  return changed ? next : (pending as Map<string, number | null>)
}

export function deleteFile(project: ProjectRecord, fileId: string): ProjectRecord {
  return { ...project, files: project.files.filter((f) => f.id !== fileId) }
}
