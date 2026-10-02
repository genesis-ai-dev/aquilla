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
  const byId = new Map(writes.map((w) => [w.fileId, w.sortIndex]))
  const nextFiles = project.files.map((f) => {
    if (!byId.has(f.id)) return f
    const sortIndex = byId.get(f.id)
    if (sortIndex === null || sortIndex === undefined) {
      const { sortIndex: _dropped, ...rest } = f
      return rest
    }
    return { ...f, sortIndex }
  })
  return { ...project, files: nextFiles }
}

export function deleteFile(project: ProjectRecord, fileId: string): ProjectRecord {
  return { ...project, files: project.files.filter((f) => f.id !== fileId) }
}
