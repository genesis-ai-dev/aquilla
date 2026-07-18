import { v4 as uuid } from "uuid"
import type { TranslatableString, CellType } from "./types"
import { splitIntoSegments } from "./text-splitter"
import { isBookTitleOrIntroMarker } from "./usfm-lossless"

export interface UsfmBookResult {
  bookId: string
  strings: TranslatableString[]
}

export function extractUsfmStrings(content: string): UsfmBookResult[] {
  const hasId = /\\id\s/.test(content)

  if (!hasId) {
    return [parseBookSection(content, "unknown")]
  }

  const sections = content.split(/(?=\\id\s)/).filter((s) => s.trim().length > 0)
  return sections.map((section) => {
    const idMatch = section.match(/\\id\s+(\S+)/)
    const bookId = idMatch ? idMatch[1] : "unknown"
    return parseBookSection(section, bookId)
  })
}

// Aligned USFM3 (unfoldingWord en_ult/en_ust/hbo_uhb/el-x-koine_ugnt) puts every word
// on its own line inside \zaln-s ...\* / \zaln-e\* milestones and \w word|attrs\w*
// wrappers; hbo_uhb even emits bare "\v N" lines with the words on following lines.
// Normalize such sections back to one-physical-line-per-verse plain USFM so the
// line-based parser below sees ordinary input. Sections without alignment/word markup
// are returned untouched, so plain-USFM output is byte-identical to before.
const ALIGNED_MARKUP = /\\zaln-s|\\w[\s*]/
// Joining word lines must not insert a space before punctuation (incl. Hebrew
// sof pasuq ׃ and maqqef ־, which trail outside the \w wrapper).
const LEADING_PUNCT = /^[,.;:!?)׃־]/

function normalizeAlignedUsfm(section: string): string {
  if (!ALIGNED_MARKUP.test(section)) return section

  // Milestones become a space (not ""), so adjacent groups on one line cannot fuse
  // words together; the verse-line cleanup below collapses the extra whitespace.
  const stripped = section
    .replace(/\\zaln-s[^\\]*\\\*/g, " ")
    .replace(/\\zaln-e\\\*/g, " ")
    .replace(/\\w\s+([^\\|]+?)(?:\|[^\\]*?)?\\w\*/g, "$1")

  const merged: string[] = []
  for (const raw of stripped.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const prev = merged[merged.length - 1]
    if (!line.startsWith("\\") && prev !== undefined && /^\\v\s/.test(prev)) {
      merged[merged.length - 1] = prev + (LEADING_PUNCT.test(line) ? "" : " ") + line
      continue
    }
    merged.push(line)
  }

  // Safety net: collapse runs of spaces and any space that landed before punctuation.
  return merged
    .map((l) =>
      /^\\v\s/.test(l) ? l.replace(/\s{2,}/g, " ").replace(/\s+([,.;:!?)׃])/g, "$1") : l,
    )
    .join("\n")
}

function parseBookSection(section: string, bookId: string): UsfmBookResult {
  const lines = normalizeAlignedUsfm(section).split("\n")
  const strings: TranslatableString[] = []
  let chapter = 0
  let verse = 0

  function addString(
    text: string,
    context: string,
    type: CellType,
    section: string | undefined,
    globalReferences?: string[],
  ) {
    const segments = splitIntoSegments(text)
    for (const seg of segments) {
      strings.push({
        id: uuid(),
        original: seg.text,
        translated: "",
        context,
        group: seg.group,
        section,
        ...(globalReferences && globalReferences.length > 0 ? { globalReferences } : {}),
        type,
      })
    }
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith("\\id ")) continue

    const chapterMatch = trimmed.match(/^\\c\s+(\d+)/)
    if (chapterMatch) {
      chapter = parseInt(chapterMatch[1])
      verse = 0
      continue
    }

    // Text is optional: aligned corpora (hbo_uhb) emit bare "\v N" lines whose
    // words arrive on the following lines and get appended below.
    const verseMatch = trimmed.match(/^\\v\s+(\d+)(?:\s+(.*))?$/)
    if (verseMatch) {
      verse = parseInt(verseMatch[1])
      const vref = `${bookId} ${chapter}:${verse}`
      addString(verseMatch[2] ?? "", vref, "verse", `${bookId} ${chapter}`, [vref])
      continue
    }

    const sectionMatch = trimmed.match(/^\\s\d?\s+(.*)/)
    if (sectionMatch) {
      addString(sectionMatch[1], `${bookId} ${chapter}`, "heading", `${bookId} ${chapter}`)
      continue
    }

    if (/^\\p\s*$/.test(trimmed)) continue

    const paratextMatch = trimmed.match(/^\\(mt|ms|r)(\d?)\s+(.*)/)
    if (paratextMatch) {
      // AQU-585: the main title (\mt) is the book name — front matter, not a
      // translatable source cell. Major-section (\ms) and parallel-reference
      // (\r) headings are in-body content and stay.
      if (!isBookTitleOrIntroMarker(paratextMatch[1] + paratextMatch[2])) {
        addString(paratextMatch[3], bookId, "paratext", `${bookId} intro`)
      }
      continue
    }

    if (!trimmed.startsWith("\\") && strings.length > 0) {
      const last = strings[strings.length - 1]
      last.original = last.original ? last.original + " " + trimmed : trimmed
    }
  }

  return { bookId, strings }
}
