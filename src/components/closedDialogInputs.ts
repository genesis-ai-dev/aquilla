/**
 * AQU-2655: what each lazily loaded workspace dialog still reacts to while it
 * is CLOSED — the `unchangedWhileClosed` argument of `memoWhileClosed` for
 * ExportDialog, ImportDialog and AudioRecordingModal. Kept out of the dialog
 * modules so those keep exporting components only (fast refresh), and loaded
 * with them, so the workspace chunk does not grow.
 */
import type { CellData } from "@/hooks/useCells"
import { hasBibleVerses } from "@/lib/export/exporters/html"
import type { ExportDialogProps } from "./ExportDialog"
import type { ImportDialogProps } from "./ImportDialog"
import type { AudioRecordingModalProps } from "./AudioRecorder/AudioRecordingModal"

const bibleVersesByCells = new WeakMap<readonly CellData[], boolean>()
function cellsHaveBibleVerses(cells: readonly CellData[]): boolean {
  let known = bibleVersesByCells.get(cells)
  if (known === undefined) {
    known = hasBibleVerses(cells)
    bibleVersesByCells.set(cells, known)
  }
  return known
}

/**
 * AQU-2655: what a CLOSED ExportDialog still reacts to, for `memoWhileClosed`.
 *
 * The dialog stays mounted between openings, and a few of its effects run
 * while it is closed: the base name follows the active file, the format resets
 * to the file's native one on a file switch, falls back when the project's
 * SDBH files or the file's Web-page offer go away, and the project-scope cell
 * read follows the project's files and lane. Skipping a closed render that
 * changes one of those would move that effect into the opening commit, AFTER
 * the restore-on-open effect, and the file-switch reset would then overwrite
 * the remembered format. So the closed dialog renders for exactly those
 * inputs, and for nothing else.
 */
export function exportDialogUnchangedWhileClosed(
  previous: Readonly<ExportDialogProps>,
  next: Readonly<ExportDialogProps>,
): boolean {
  if (
    previous.activeFileId !== next.activeFileId
    || previous.activeFileName !== next.activeFileName
    || previous.activeFileType !== next.activeFileType
    || previous.activeFileHasOriginalSource !== next.activeFileHasOriginalSource
    || previous.currentUsername !== next.currentUsername
    || previous.projectId !== next.projectId
    || previous.targetLang !== next.targetLang
    || previous.getToken !== next.getToken
  ) return false
  const a = previous.projectFiles
  const b = next.projectFiles
  if (a !== b) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (a[i].id !== b[i].id || a[i].name !== b[i].name || a[i].type !== b[i].type) return false
    }
  }
  // `offersHtmlPage` reads the lines only for a `codex` file.
  if (
    previous.cells !== next.cells
    && next.activeFileType === "codex"
    && cellsHaveBibleVerses(previous.cells) !== cellsHaveBibleVerses(next.cells)
  ) return false
  return true
}

/**
 * AQU-2655: what a CLOSED ImportDialog still reacts to, for `memoWhileClosed`.
 *
 * An import that was waiting on the direction form can be finished while the
 * dialog is closed: when lane rows arrive that already name a source and a
 * target, the direction effect completes it. That effect reads the lanes, the
 * active lane and the two languages, so the closed dialog renders when one of
 * those changes. Everything else it does while closed is reset by the next
 * opening (the render-time open initialiser and the reset-on-open effect).
 */
export function importDialogUnchangedWhileClosed(
  previous: Readonly<ImportDialogProps>,
  next: Readonly<ImportDialogProps>,
): boolean {
  return previous.lanes === next.lanes
    && previous.targetLang === next.targetLang
    && previous.sourceLanguage === next.sourceLanguage
    && previous.targetLanguage === next.targetLanguage
}

/**
 * AQU-2655: what a CLOSED recorder still reacts to, for `memoWhileClosed`.
 *
 * Closed means no line (`activeCellId` is null), so the takes read, the line
 * effects and the keyboard are all idle. The one thing it does while closed
 * is resolve the picture of the film file (`useMediaPictureUrl`), which the
 * opening then shows without waiting: the closed recorder renders when that
 * file, or its stored picture, changes.
 */
export function audioRecordingModalUnchangedWhileClosed(
  previous: Readonly<AudioRecordingModalProps>,
  next: Readonly<AudioRecordingModalProps>,
): boolean {
  return previous.project.id === next.project.id
    && previous.filmFileId === next.filmFileId
    && storedFilmPicture(previous) === storedFilmPicture(next)
}

function storedFilmPicture({ project, filmFileId }: Readonly<AudioRecordingModalProps>): string | null | undefined {
  return filmFileId ? project.files?.find((f) => f.id === filmFileId)?.coreMediaUrl : undefined
}
