import { useSectionProgressState } from "@/hooks/useSectionProgress"
import { BookHealthSpine, type BookHealthChapter } from "./BookHealthSpine"

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
  const { sections, error, retry } = useSectionProgressState(projectId, fileId, validationCount, getTokenForFile)

  if (!chapters && sections === null) {
    return <div className="px-6 py-1 text-[10px] text-muted-foreground">Loading…</div>
  }
  if (!chapters && (sections?.length ?? 0) === 0) {
    if (error) {
      return (
        <div className="flex items-center gap-2 px-6 py-1 text-[10px] text-muted-foreground">
          <span>Progress unavailable.</span>
          <button type="button" className="font-medium text-foreground hover:underline" onClick={retry}>Retry</button>
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
