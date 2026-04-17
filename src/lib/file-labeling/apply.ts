import type { ProjectRecord } from "@/lib/parsers/types"
import type { RenameSuggestion } from "./detect"

export function applySuggestions(
  project: ProjectRecord, suggestions: RenameSuggestion[],
): ProjectRecord {
  const byId = new Map(suggestions.map((s) => [s.fileId, s]))
  const nextFiles = project.files.map((f) => {
    const s = byId.get(f.id)
    if (!s) return f
    const nameChanged = f.name !== s.suggestedName
    return {
      ...f,
      name: s.suggestedName,
      corpusMarker: s.suggestedCorpus ?? f.corpusMarker,
      originalName: nameChanged && !f.originalName ? f.name : f.originalName,
    }
  })
  return { ...project, files: nextFiles }
}

export function buildUndo(
  project: ProjectRecord, suggestions: RenameSuggestion[],
): ProjectRecord {
  const byId = new Map(suggestions.map((s) => [s.fileId, s]))
  const nextFiles = project.files.map((f) => {
    const s = byId.get(f.id)
    if (!s) return f
    const { originalName: _unused, ...rest } = f
    return {
      ...rest,
      name: s.currentName,
      corpusMarker: s.currentCorpus,
    }
  })
  return { ...project, files: nextFiles }
}
