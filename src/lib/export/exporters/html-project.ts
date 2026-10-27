// Whole-project HTML export (AQU-2183): one zip holding a readable page per
// USFM book — the same page AQU-2182 writes for the open book — plus an
// `index.html` that lists every book in canonical order and links to them.
//
// Why a zip of pages rather than one giant page: a full New Testament in a
// single document is slow to open and impossible to navigate, and partners
// asked for the Codex shape (a folder you browse). Each page stays
// self-contained — inline CSS, no shared stylesheet — so one book can be
// forwarded on its own, and the only thing tying them together is a relative
// link each way.
//
// What counts as a book: a file whose cells carry a canonical scripture
// reference, or failing that whose NAME names a book. References win, because
// they are the content — a file misnamed `40-MAT.usfm` whose rows read
// `MRK 1:1` is Mark. Anything neither test resolves (a DOCX, a glossary, a
// subtitle file) is not a USFM book and is skipped, and the caller reports how
// many were. Both tests only ever resolve the 66 canonical books, which is why
// a non-canonical book sorts last rather than being special-cased: the
// ordering is ready for one, the detectors cannot see one yet.
//
// Page names carry the book's CANONICAL ordinal, not its position in this
// project (`01-GEN.html`, `40-MAT.html`), so an unzipped folder sorts in Bible
// order in any file browser without the reader doing anything. Two files of the
// same book — migrated projects hold duplicate legacy notebooks — both export,
// the second as `01-GEN-2.html`: neither may silently overwrite the other.
//
// A book with nothing to export (validated-only is on and none of it is
// validated) gets NO page and is still listed in the index, marked. A reader
// can see the book exists in the project without opening a blank page.
import JSZip from "jszip"
import {
  buildHtmlPage,
  escapeHtml,
  htmlExportFooter,
  htmlPageShell,
  summarizeHtmlCells,
  type HtmlExportCell,
} from "./html"
import { bookCodeFromFileName, getBookName, getBookOrdinal } from "@/lib/file-labeling/bible-book-names"
import { parseScriptureReference } from "@/lib/scripture-reference"

/** The index page's file name, and the href every book page links back to. */
export const HTML_INDEX_ENTRY = "index.html"

const BACK_LINK_LABEL = "← All books"
const INDEX_TITLE_FALLBACK = "Books"
const EMPTY_BOOK_NOTE = "no verses exported"

/** One project file, with its cells already scoped by the dialog (hidden
 *  cells, validated-only) exactly as the single-book path scopes them. */
export interface HtmlProjectFileInput {
  fileId: string
  fileName: string
  /** The rows the page is built from — already scoped. */
  cells: readonly HtmlExportCell[]
  /** The file's rows BEFORE scoping, read only to decide WHICH BOOK the file
   *  is. Defaults to `cells`.
   *
   *  It has to be separate: validated-only can drop every row of a book, and
   *  such a book must still appear in the index (marked, with no page). Read
   *  the book off the surviving rows and it would instead vanish from the
   *  export altogether — the project would look like it never held it. */
  identityCells?: readonly HtmlExportCell[]
}

export interface BuildHtmlProjectZipOptions {
  files: readonly HtmlProjectFileInput[]
  /** The project name, titling `index.html`. */
  title?: string | null
  /** True when the dialog's content mode left non-validated cells out. */
  validatedOnly?: boolean
  /** Language of the exported text, for `<html lang>` on every page. */
  lang?: string | null
  /** The export moment, for the footers. Injectable so tests are byte-stable. */
  now?: Date
}

/** A file the plan recognised as a book, with the page it will be written to. */
export interface PlannedHtmlBook {
  fileId: string
  fileName: string
  bookCode: string
  /** "Genesis" — the display name the index and the page title show. */
  bookName: string
  /** Canonical ordinal, or -1 for a book outside the 66 (sorts last). */
  ordinal: number
  /** The zip entry this book's page is written to, or null when the book has
   *  nothing to export — then it is indexed but no file is written. */
  pageName: string | null
  /** Lines the page would render; 0 is exactly why `pageName` is null. */
  lines: number
  /** Of those, how many fell back to source text. */
  untranslated: number
  /** True when another file in the project is the same book, so the index
   *  needs the file name to tell the two entries apart. */
  duplicate: boolean
}

export interface HtmlProjectPlan {
  /** Books in canonical order, duplicates of a book adjacent and stable. */
  books: PlannedHtmlBook[]
  /** Names of the files that are not USFM books, in input order. */
  skipped: string[]
}

export interface HtmlProjectZipResult {
  blob: Blob
  /** Books in the index — including any that got no page of their own. */
  booksExported: number
  /** Files left out because they are not USFM books. */
  filesSkipped: number
}

/** The book a file is, read from its rows and then from its name. */
function resolveBook(file: HtmlProjectFileInput): { code: string; name: string } | null {
  for (const cell of file.identityCells ?? file.cells) {
    const ref = parseScriptureReference(cell.group)
    if (ref) return { code: ref.bookCode, name: ref.bookName }
  }
  const code = bookCodeFromFileName(file.fileName)
  return code ? { code, name: getBookName(code) ?? code } : null
}

/** Two digits so a file browser's string sort is the canonical one — `09-` and
 *  `40-` compare correctly, which `9-` and `40-` do not. */
function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/**
 * Which files become pages, under which names, in which order — decided before
 * a single byte is written so it can be tested without unzipping anything.
 */
export function planHtmlProjectExport(files: readonly HtmlProjectFileInput[]): HtmlProjectPlan {
  const skipped: string[] = []
  const found: Array<Omit<PlannedHtmlBook, "pageName" | "duplicate">> = []

  for (const file of files) {
    const book = resolveBook(file)
    if (!book) {
      skipped.push(file.fileName)
      continue
    }
    const { lines, untranslated } = summarizeHtmlCells(file.cells)
    found.push({
      fileId: file.fileId,
      fileName: file.fileName,
      bookCode: book.code,
      bookName: book.name,
      ordinal: getBookOrdinal(book.code),
      lines,
      untranslated,
    })
  }

  // Canonical order; a book outside the 66 after all of them. Ties (the same
  // book twice) keep the project's own file order, so a re-export names the
  // same page for the same file.
  const sorted = [...found].sort((a, b) => {
    if (a.ordinal !== b.ordinal) {
      if (a.ordinal < 0) return 1
      if (b.ordinal < 0) return -1
      return a.ordinal - b.ordinal
    }
    return files.findIndex((f) => f.fileId === a.fileId) - files.findIndex((f) => f.fileId === b.fileId)
  })

  const timesSeen = new Map<string, number>()
  for (const b of sorted) timesSeen.set(b.bookCode, (timesSeen.get(b.bookCode) ?? 0) + 1)

  const used = new Map<string, number>()
  // Books the detectors cannot place sit after the 66, in the order they came.
  let unplaced = 0
  const books: PlannedHtmlBook[] = sorted.map((b) => {
    const prefix = b.ordinal >= 0 ? b.ordinal + 1 : 67 + unplaced++
    const seen = (used.get(b.bookCode) ?? 0) + 1
    used.set(b.bookCode, seen)
    const stem = `${pad2(prefix)}-${b.bookCode}${seen > 1 ? `-${seen}` : ""}`
    return {
      ...b,
      pageName: b.lines > 0 ? `${stem}.html` : null,
      duplicate: (timesSeen.get(b.bookCode) ?? 0) > 1,
    }
  })

  return { books, skipped }
}

/** The zip's `index.html`: every book in canonical order, the ones with a page
 *  as links, with the book pages' own shell and footer. */
export function buildHtmlIndexPage(
  books: readonly PlannedHtmlBook[],
  opts: Omit<BuildHtmlProjectZipOptions, "files"> = {},
): string {
  const title = (opts.title ?? "").trim() || INDEX_TITLE_FALLBACK
  const entries = books.map((b) => {
    // A duplicated book needs its file name to be told from its twin; an
    // unduplicated one does not, so it stays a clean book name.
    const name = escapeHtml(b.bookName)
    const label = b.duplicate ? `${name} <span class="file-note">(${escapeHtml(b.fileName)})</span>` : name
    return b.pageName
      ? `<li><a href="${escapeHtml(b.pageName)}">${label}</a></li>`
      : `<li class="empty">${label}<span class="empty-note">${EMPTY_BOOK_NOTE}</span></li>`
  })
  const untranslated = books.reduce((sum, b) => sum + b.untranslated, 0)
  const body = [
    `<h1 class="book-title">${escapeHtml(title)}</h1>`,
    `<ol class="book-list">\n${entries.join("\n")}\n</ol>`,
    htmlExportFooter({ validatedOnly: opts.validatedOnly, now: opts.now }, untranslated),
  ].join("\n")
  return htmlPageShell({ title, lang: opts.lang, body })
}

/**
 * Build the zip: `index.html` plus one page per book that has something to
 * export. Non-USFM files never enter it, and the result says how many of each
 * so the dialog can report it.
 */
export async function buildHtmlProjectZip(opts: BuildHtmlProjectZipOptions): Promise<HtmlProjectZipResult> {
  const { files, title, validatedOnly, lang, now } = opts
  const plan = planHtmlProjectExport(files)
  const byFileId = new Map(files.map((f) => [f.fileId, f]))
  const zip = new JSZip()

  zip.file(HTML_INDEX_ENTRY, buildHtmlIndexPage(plan.books, { title, validatedOnly, lang, now }))

  for (const book of plan.books) {
    if (!book.pageName) continue
    const file = byFileId.get(book.fileId)
    if (!file) continue
    zip.file(
      book.pageName,
      buildHtmlPage(file.cells, {
        fileName: file.fileName,
        validatedOnly,
        lang,
        now,
        backLink: { href: HTML_INDEX_ENTRY, label: BACK_LINK_LABEL },
      }),
    )
  }

  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" })
  return { blob, booksExported: plan.books.length, filesSkipped: plan.skipped.length }
}
