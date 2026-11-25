// Clipboard text for a cell selection.
//
// The editor list recycles rows that scroll out of view, so a browser text
// selection never contains a whole chapter. Copy reads the cells themselves
// and writes one paragraph per line, which Word pastes as separate paragraphs.

import { chapterLabelFromCanonical, parseScriptureReference } from "@/lib/scripture-reference"

export interface SelectionCopyLine {
  /** The # column label ("1", "4a"). Null on a heading. */
  number: string | null
  /** "GEN 1" when the line sits in a chapter. Null on a heading. */
  chapter: string | null
  /** "Genesis 1". Shown only when the selection spans more than one chapter. */
  chapterLabel: string | null
  text: string
}

export interface FormattedSelectionCopy {
  text: string
  html: string
}

/** Book + chapter of a canonical ref, or null when it is not one. */
export function chapterOfReference(value: string | null | undefined): { key: string; label: string } | null {
  const ref = parseScriptureReference(value)
  if (!ref) return null
  const key = `${ref.bookCode} ${ref.chapter}`
  return { key, label: chapterLabelFromCanonical(value) ?? key }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** One paragraph per line, in the order given. A selection that crosses a
 *  chapter boundary names each chapter once, so a restarted verse number
 *  still says which chapter it belongs to. */
export function formatSelectionCopy(lines: readonly SelectionCopyLine[]): FormattedSelectionCopy {
  const chapters = new Set<string>()
  for (const line of lines) {
    if (line.chapter) chapters.add(line.chapter)
  }
  const spansChapters = chapters.size > 1
  const paragraphs: string[] = []
  let lastChapter: string | null = null
  for (const line of lines) {
    const body = line.text.replace(/\r\n/g, "\n").trim()
    if (!body) continue
    if (spansChapters && line.chapter && line.chapter !== lastChapter) {
      paragraphs.push(line.chapterLabel?.trim() || line.chapter)
      lastChapter = line.chapter
    }
    paragraphs.push(line.number ? `${line.number} ${body}` : body)
  }
  const text = paragraphs.join("\n")
  const html = paragraphs
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("")
  return { text, html }
}

/** Write both HTML and plain text so Word keeps one paragraph per line.
 *  Falls back to plain text where the richer clipboard call is refused. */
export async function writeFormattedSelection(payload: FormattedSelectionCopy): Promise<void> {
  const clipboard = navigator.clipboard
  if (clipboard.write && typeof ClipboardItem !== "undefined") {
    try {
      await clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([payload.text], { type: "text/plain" }),
          "text/html": new Blob([payload.html], { type: "text/html" }),
        }),
      ])
      return
    } catch {
      // The page can still hand Word the plain text.
    }
  }
  await clipboard.writeText(payload.text)
}
