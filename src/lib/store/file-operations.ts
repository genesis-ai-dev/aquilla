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

export function deleteFile(project: ProjectRecord, fileId: string): ProjectRecord {
  return { ...project, files: project.files.filter((f) => f.id !== fileId) }
}
