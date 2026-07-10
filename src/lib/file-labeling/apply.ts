import type { ProjectRecord } from "@/lib/parsers/types"
import type { RenameSuggestion } from "./detect"

/**
 * Does applying this suggestion actually change anything? A suggestion whose
 * name and corpus already match the file is a no-op and must not be applied or
 * reported as a successful rename (AQU-374: "runs to success but doesn't rename
 * anything"). `suggestedCorpus` is optional; an absent value means "leave the
 * corpus as-is", so it never counts as a change.
 */
export function hasEffectiveChange(s: RenameSuggestion): boolean {
  const nameChanged = s.currentName !== s.suggestedName
  const corpusChanged = s.suggestedCorpus != null && s.suggestedCorpus !== s.currentCorpus
  return nameChanged || corpusChanged
}

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
    const rest = { ...f }
    delete rest.originalName
    return {
      ...rest,
      name: s.currentName,
      corpusMarker: s.currentCorpus,
    }
  })
  return { ...project, files: nextFiles }
}
