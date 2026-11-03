// AQU-981: the lines a bulk upload can land on, read from the sync worker for
// any file in the project — the editor's cell store only ever holds the open
// one, and a project-wide upload names many books at once.

import { fetchAllFileCells, fetchFileCells } from "@/lib/sync/cells-read"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { fetchFileAudioAttachments } from "@/lib/sync/cell-audio-read"
import { cellHasOwnTake } from "@/lib/progress/audio-progress-cells"
import { isStructuralCell } from "@/lib/cells/structural"
import { bookCodeFromFileName, isKnownBookCode } from "@/lib/file-labeling/bible-book-names"
import { usfmDisplayText } from "@/lib/parsers/usfm-display"
import type { ProjectFileInfo, TargetFile, TargetLine } from "./match"
import type { BookNameIndex } from "./book-names"

export interface ProjectFileLike {
  id: string
  name: string
  bookCode?: string
  displayLabel?: string
  originalName?: string
  /** Hidden audio-cue siblings and the like have a role besides "source". */
  role?: string | null
}

/** A project file's book code, from its import record or, failing that, its name. */
export function bookCodeOf(file: ProjectFileLike): string | null {
  const code = file.bookCode?.toUpperCase()
  if (code && isKnownBookCode(code)) return code
  return bookCodeFromFileName(file.name) ?? null
}

/** The project's files as the matcher sees them, and its own names for books. */
export function projectFileInfos(files: readonly ProjectFileLike[], index: BookNameIndex): ProjectFileInfo[] {
  const explicit: ProjectFileInfo[] = []
  const guessed: ProjectFileInfo[] = []
  for (const f of files) {
    if (f.role && f.role !== "source") continue
    const bookCode = bookCodeOf(f)
    // A file whose import recorded its book is that book before one whose
    // name merely starts with it ("Ruth notes").
    const isExplicit = Boolean(f.bookCode && bookCode === f.bookCode.toUpperCase())
    ;(isExplicit || !bookCode ? explicit : guessed).push({ fileId: f.id, name: f.displayLabel || f.name, bookCode })
    if (bookCode) {
      // Whatever the project calls the book is a name for it too.
      for (const name of [f.name, f.displayLabel, f.originalName]) if (name) index.addProjectName(name, bookCode)
    }
  }
  return [...explicit, ...guessed]
}

const HEADER_TEXT_MAX = 48

/**
 * A Bible file's own names for its book: the title lines at its head (\h,
 * \toc1–3, \mt), in the source and in the language being recorded. Read from
 * the first page only — they come before chapter 1.
 */
export async function learnHeaderNames(
  projectId: string,
  file: ProjectFileInfo,
  jwt: string,
  lane: string,
  index: BookNameIndex,
): Promise<void> {
  if (!file.bookCode) return
  const page = await fetchFileCells(projectId, file.fileId, { limit: 40, ...(lane ? { lane } : {}) }, jwt)
  for (const row of page.cells) {
    if (!isStructuralCell(row.type)) continue
    const ref = row.canonicalRef ?? ""
    if (ref.includes(":")) continue
    const text = usfmDisplayText(row.value ?? "").trim()
    if (text && text.length <= HEADER_TEXT_MAX) index.addProjectName(text, file.bookCode)
  }
}

function lineText(source: CellRow, target: CellRow | undefined): string {
  const raw = target?.value?.trim() ? target.value : source.value
  return usfmDisplayText(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 140)
}

/** Every visible line of one file, with which ones already have a recording. */
export async function loadTargetFile(
  projectId: string,
  file: ProjectFileInfo,
  jwt: string,
  lane: string,
): Promise<TargetFile> {
  const [source, target, audio] = await Promise.all([
    fetchAllFileCells(projectId, file.fileId, jwt, "source"),
    fetchAllFileCells(projectId, file.fileId, jwt, "target", lane),
    fetchFileAudioAttachments(projectId, file.fileId, jwt, lane).catch(() => null),
  ])
  const targetById = new Map(target.map((row) => [row.cellId, row]))
  const lines: TargetLine[] = []
  // A subtitle or film file: its lines have times (a cue's start).
  let timed = false
  for (const row of source) {
    if (row.hidden) continue
    if (row.startMs != null && !isStructuralCell(row.type)) timed = true
    lines.push({
      cellId: row.cellId,
      ref: row.canonicalRef,
      text: lineText(row, targetById.get(row.cellId)),
      structural: isStructuralCell(row.type),
      hasRecording: cellHasOwnTake(row.cellId, audio?.cells[row.cellId]),
    })
  }
  return { fileId: file.fileId, name: file.name, bookCode: file.bookCode, lines, timed }
}
