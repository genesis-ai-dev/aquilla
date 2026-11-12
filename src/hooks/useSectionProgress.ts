import { useEffect, useRef } from "react"
import type { SectionProgress } from "@/lib/progress/section-progress"
import { invalidateFileProgress, useFileProgressResource } from "@/lib/progress/file-progress-resource"
import { progressPercent } from "@/lib/progress/progress-percent"

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
  lane = '',
): SectionProgress[] | null {
  const state = useSectionProgressState(
    projectId, fileId, validationCount, getTokenForFile, countStructural, lane,
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
 *
 * AQU-2118: `lane` is the target lane the sections are read for — the one the
 * sidebar's switcher shows. Progress is materialized per lane (AQU-538), and
 * a read that names none gets the project's own default lane, which is not
 * the open one on a multi-lane project. '' is the default lane, as everywhere.
 */
export function useSectionProgressState(
  projectId: string | null,
  fileId: string | null,
  validationCount: number,
  getTokenForFile: ((fileId: string) => Promise<string | null>) | undefined,
  countStructural = true,
  lane = '',
): { sections: SectionProgress[] | null; error: boolean; retry: () => void } {
  const resource = useFileProgressResource(projectId, fileId, getTokenForFile, lane)
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
    if (changed && projectId && fileId) invalidateFileProgress(projectId, fileId, lane)
  }, [fileId, lane, projectId, validationCount, countStructural])
  const sections = resource.progress
    ? resource.progress.sections.map((section) => ({
        label: section.key,
        cellIds: [],
        textCompleted: percent(section.filledCount, section.totalCount),
        textValidated: percent(section.validatedCount, section.totalCount),
        textValidationLevels: section.validationLevels.map((count) => percent(count, section.totalCount)),
        // AQU-2112: the server has always sent these two beside the text
        // counts — lines with a take of their own, and those whose every
        // chosen take meets the project's audio validation requirement — and
        // this mapper threw them away for a hardcoded zero. That is why an
        // audio-only file expanded in the sidebar read 0% however many of its
        // takes were signed off.
        //
        // Absent (an older worker, or the editor's own optimistic snapshot,
        // which knows nothing about audio) still reads as zero WITH
        // `hasAudio` false, so a file with no recordings is unchanged: the
        // flag, not the count, is what says audio is being measured here.
        audioCompleted: percent(section.audioCount ?? 0, section.totalCount),
        audioValidated: percent(section.audioValidatedCount ?? 0, section.totalCount),
        audioValidationLevels: [],
        hasAudio: (section.audioCount ?? 0) > 0,
      }))
    : resource.loading ? null : []
  return { sections, error: resource.error, retry: resource.retry }
}

// AQU-1493: the sidebar's chapter figures never round outstanding work up to
// 100%, and its "complete" colour reads `>= 100`, so this is that test too.
const percent = progressPercent
