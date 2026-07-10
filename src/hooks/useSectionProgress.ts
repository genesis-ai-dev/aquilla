import { useEffect, useRef } from "react"
import type { SectionProgress } from "@/lib/progress/section-progress"
import { invalidateFileProgress, useFileProgressResource } from "@/lib/progress/file-progress-resource"

/**
 * Read compact server-maintained section progress. The hook never fetches cell
 * rows; a small IndexedDB snapshot paints first and is revalidated by ETag.
 *
 * Returns null while loading, [] when the file has no section-bearing cells,
 * SectionProgress[] otherwise. Errors degrade to []: a missing sub-list is
 * less confusing in the sidebar than a "Loading…" that never resolves.
 */
export function useSectionProgress(
  projectId: string | null,
  fileId: string | null,
  validationCount: number,
  getTokenForFile: ((fileId: string) => Promise<string | null>) | undefined,
): SectionProgress[] | null {
  const state = useSectionProgressState(projectId, fileId, validationCount, getTokenForFile)
  return state.sections
}

/**
 * Map compact server counts to the legacy sidebar presentation shape. The
 * validation threshold is projected server-side from its validator histogram.
 */
export function useSectionProgressState(
  projectId: string | null,
  fileId: string | null,
  validationCount: number,
  getTokenForFile: ((fileId: string) => Promise<string | null>) | undefined,
): { sections: SectionProgress[] | null; error: boolean; retry: () => void } {
  const resource = useFileProgressResource(projectId, fileId, getTokenForFile)
  const previousValidationCount = useRef(validationCount)
  useEffect(() => {
    const changed = previousValidationCount.current !== validationCount
    previousValidationCount.current = validationCount
    if (changed && projectId && fileId) invalidateFileProgress(projectId, fileId)
  }, [fileId, projectId, validationCount])
  const sections = resource.progress
    ? resource.progress.sections.map((section) => ({
        label: section.key,
        cellIds: [],
        textCompleted: percent(section.filledCount, section.totalCount),
        textValidated: percent(section.validatedCount, section.totalCount),
        textValidationLevels: section.validationLevels.map((count) => percent(count, section.totalCount)),
        audioCompleted: 0,
        audioValidated: 0,
        audioValidationLevels: [],
        hasAudio: false,
      }))
    : resource.loading ? null : []
  return { sections, error: resource.error, retry: resource.retry }
}

function percent(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 100) : 0
}
