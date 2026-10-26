import { useMemo } from "react"
import { useSectionProgressState } from "@/hooks/useSectionProgress"
import { Spinner } from "@/components/ui/spinner"
import { BookHealthSpine, type BookHealthChapter } from "./BookHealthSpine"
import { useT } from "@/lib/i18n/I18nProvider"
import { progressViewFor } from "@/lib/progress/milestone-progress-view"
import { deliversView, type LaneDelivers } from "@/lib/lanes/lane-delivers"

interface Props {
  projectId: string
  fileId: string
  validationCount: number
  /** AQU-1083: the project's effective structural-cell policy. Flipping it
   *  changes every number below, so the snapshot has to be revalidated. */
  countStructural?: boolean
  getTokenForFile: (fileId: string) => Promise<string | null>
  onSectionClick: (sectionLabel: string) => void
  /** Read the active file’s current health only while this grid is mounted. */
  getChapters?: () => BookHealthChapter[]
  /**
   * AQU-1326: hold the per-file `/progress` read until the editor's first cell
   * page has painted. The active file is expanded on open, so this grid's fetch
   * otherwise goes out just ahead of the cell stream and takes a slot from it.
   * Deferring costs nothing visible — the same spinner shows either way, and
   * for the active file the spine renders from `getChapters` regardless.
   */
  deferFetch?: boolean
  /**
   * AQU-2118: the target lane the sections are read for — the one the
   * sidebar's switcher shows. Omitted, the read names no lane and the server
   * answers the project's default, which is not the open lane on a
   * multi-lane project.
   */
  lane?: string
  /**
   * Media redesign: what that language delivers, when someone has chosen. It
   * decides the unit the chapters are drawn in (`deliversView`); absent, the
   * file's own evidence does, as below.
   */
  delivers?: LaneDelivers | null
}

/** Sections shown beneath an expanded file, with per-cell health squares. */
export function FileSectionGrid({ projectId, fileId, validationCount, countStructural, getTokenForFile, onSectionClick, getChapters, deferFetch, lane, delivers }: Props) {
  const t = useT()
  const chapters = useMemo(() => getChapters?.(), [getChapters])
  // A null fileId is the hook's own no-op: it skips the fetch and re-fires as
  // soon as a real id arrives, so the gate needs no extra plumbing.
  const { sections, error, retry } = useSectionProgressState(
    projectId,
    deferFetch ? null : fileId,
    validationCount,
    getTokenForFile,
    countStructural,
    lane,
  )

  if (!chapters && sections === null) {
    return (
      <div className="flex items-center px-6 py-1 text-muted-foreground" aria-label={t("common.loading")}>
        <Spinner className="size-3" />
      </div>
    )
  }
  if (!chapters && (sections?.length ?? 0) === 0) {
    if (error) {
      return (
        <div className="flex items-center gap-2 px-6 py-1 text-[10px] text-muted-foreground">
          <span>{t("nav.fileSectionGrid.progressUnavailable")}</span>
          <button type="button" className="font-medium text-foreground hover:underline" onClick={retry}>{t("common.retry")}</button>
        </div>
      )
    }
    return null
  }

  // AQU-2112: a file expanded WITHOUT being opened is drawn from the server's
  // per-chapter progress, which carries the audio pair — so the chapter list
  // shows it, in the same unit the chapter picker would. The view is decided
  // over the whole file by AQU-2110's shared rule, so a file never shows a
  // patchwork of chapters measured in different things — and what the
  // language delivers overrides it where someone has chosen.
  const serverChapters = sections ?? []
  const serverView = deliversView(delivers, progressViewFor(serverChapters.map((section) => ({
    translated: Math.round(section.textCompleted),
    validated: Math.round(section.textValidated),
    total: 100,
    // `textCompleted` is target text alone server-side — a take never counts
    // toward it — which is exactly the distinction the rule needs.
    textTranslated: Math.round(section.textCompleted),
    audioRecorded: Math.round(section.audioCompleted),
    audioValidated: Math.round(section.audioValidated),
  }))))
  const spineChapters: BookHealthChapter[] = chapters ?? serverChapters.map((section) => ({
    key: section.label,
    label: section.label,
    translated: Math.round(section.textCompleted),
    validated: Math.round(section.textValidated),
    total: 100,
    percentagesOnly: true,
    audioRecorded: Math.round(section.audioCompleted),
    audioValidated: Math.round(section.audioValidated),
    progressView: serverView,
  }))

  return (
    <BookHealthSpine
      chapters={spineChapters}
      onChapterClick={onSectionClick}
      // AQU-1187: per (project, file), so folding Genesis shut in one file
      // doesn't fold it in another.
      bookCollapseStorageKey={`aquilla:sidebar:book-collapsed:${projectId}:${fileId}`}
    />
  )
}
