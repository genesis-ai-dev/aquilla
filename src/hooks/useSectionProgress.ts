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
  countStructural = true,
): SectionProgress[] | null {
  const state = useSectionProgressState(
    projectId, fileId, validationCount, getTokenForFile, countStructural,
  )
  return state.sections
}

/**
 * Map compact server counts to the legacy sidebar presentation shape. The
 * validation threshold is projected server-side from its validator histogram.
 *
 * AQU-1083: so is the structural-cell policy, and for the same reason it has
 * to be passed in here — the server resolves it, this snapshot caches the
 * answer, and nothing in the response says which policy produced it. The
 * default counts headings, which is what every caller meant before the
 * setting existed.
 */
export function useSectionProgressState(
  projectId: string | null,
  fileId: string | null,
  validationCount: number,
  getTokenForFile: ((fileId: string) => Promise<string | null>) | undefined,
  countStructural = true,
): { sections: SectionProgress[] | null; error: boolean; retry: () => void } {
  const resource = useFileProgressResource(projectId, fileId, getTokenForFile)
  // Both policies alter every number in the cached snapshot without touching
  // the file's revision, so a flip has to force the refetch itself — the ETag
  // carries each one, but only a request can discover that.
  const previousPolicy = useRef({ validationCount, countStructural })
  useEffect(() => {
    const previous = previousPolicy.current
    previousPolicy.current = { validationCount, countStructural }
    const changed =
      previous.validationCount !== validationCount
      || previous.countStructural !== countStructural
    if (changed && projectId && fileId) invalidateFileProgress(projectId, fileId)
  }, [fileId, projectId, validationCount, countStructural])
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
