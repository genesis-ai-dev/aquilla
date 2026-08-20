import { useSectionProgressState } from "@/hooks/useSectionProgress"
import { Spinner } from "@/components/ui/spinner"
import { BookHealthSpine, type BookHealthChapter } from "./BookHealthSpine"
import { useT } from "@/lib/i18n/I18nProvider"

interface Props {
  projectId: string
  fileId: string
  validationCount: number
  getTokenForFile: (fileId: string) => Promise<string | null>
  onSectionClick: (sectionLabel: string) => void
  chapters?: BookHealthChapter[]
}

/** Sections shown beneath an expanded file, with per-cell health squares. */
export function FileSectionGrid({ projectId, fileId, validationCount, getTokenForFile, onSectionClick, chapters }: Props) {
  const t = useT()
  const { sections, error, retry } = useSectionProgressState(projectId, fileId, validationCount, getTokenForFile)

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

  const spineChapters: BookHealthChapter[] = chapters ?? (sections ?? []).map((section) => ({
    key: section.label,
    label: section.label,
    translated: Math.round(section.textCompleted),
    validated: Math.round(section.textValidated),
    total: 100,
    percentagesOnly: true,
  }))

  return <BookHealthSpine chapters={spineChapters} onChapterClick={onSectionClick} />
}
