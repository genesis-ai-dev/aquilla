import { v4 as uuid } from "uuid"
import type { TranslatableString, CellType } from "./types"
import { splitIntoSegments } from "./text-splitter"

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

// Poetry/paragraph-flow markers are CONTAINERS, not content: drop the marker token
// and keep the remainder — either a mid-line verse start ("\q1 \v 2 …") or
// continuation text of the open verse. \b (blank line) and \nb (no-break) carry no
// text, so stripping them leaves an empty line that is skipped.
const CONTAINER_MARKER = /^\\(?:qr|qc|q[1-4]?|mi|m|pi[1-3]?|li[1-3]?|nb|b)(?=\s|$)/

// Footnotes (\f + \ft …\f*, possibly containing \fqa etc. and spanning lines) and
// cross-references (\x …\x*) are apparatus, not verse text: strip whole spans before
// line parsing. Files without notes pass through byte-identical — the per-line space
// cleanup only runs when a note was actually removed.
function stripNotes(section: string): string {
  if (!/\\[fx]\s/.test(section)) return section
  return section
    // Closed notes strip as a whole span (multi-line bodies are fine), but the span
    // must never cross a \v or \c marker: an unterminated \f would otherwise pair
    // with the NEXT verse's \f* and swallow every verse in between.
    .replace(/\\f\s(?:(?!\\v\s|\\c\s)[\s\S])*?\\f\*/g, " ")
    .replace(/\\x\s(?:(?!\\v\s|\\c\s)[\s\S])*?\\x\*/g, " ")
    // A dangling opener (no closer before the next verse/chapter) strips only to
    // end-of-line, so the following verses survive.
    .replace(/\\[fx]\s[^\n]*/g, " ")
    // Orphaned closers left behind when a dangling opener's \f* sat verses later.
    .replace(/\\[fx]\*/g, " ")
    .split("\n")
    .map((l) => l.replace(/\s{2,}/g, " ").replace(/\s+([,.;:!?)׃])/g, "$1").trimEnd())
    .join("\n")
}

// \qs …\qs* (Selah) is an inline character style whose inner text IS verse text:
// unwrap it like \w (keep the contents, drop the markers) so Psalms are complete.
// A dangling \qs without its closer just loses the marker token. Files without \qs
// pass through untouched (byte-identical guarantee for plain USFM).
function unwrapSelah(section: string): string {
  if (!/\\qs/.test(section)) return section
  return section.replace(/\\qs\s+([\s\S]*?)\\qs\*/g, "$1").replace(/\\qs\*?/g, "")
}

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
    let line = raw.trim()
    // Poetry lines ("\q1 \v 2 …", "\q2 <words>") continue the verse: unwrap the
    // container so word lines merge into the open "\v" line below.
    const container = line.match(CONTAINER_MARKER)
    if (container) line = line.slice(container[0].length).trim()
    if (!line) continue
    const prev = merged[merged.length - 1]
    if (!line.startsWith("\\") && prev !== undefined && /^\\v\s/.test(prev)) {
      merged[merged.length - 1] = prev + (LEADING_PUNCT.test(line) ? "" : " ") + line
      continue
    }
    merged.push(line)
  }

  // Safety net: collapse runs of spaces, any space that landed before punctuation,
  // and padding inside ULT's {curly braces} (implied words — the braces and their
  // inner text are part of the translatable text and are kept).
  return merged
    .map((l) =>
      /^\\v\s/.test(l)
        ? l
            .replace(/\s{2,}/g, " ")
            .replace(/\s+([,.;:!?)׃])/g, "$1")
            .replace(/\{\s+/g, "{")
            .replace(/\s+\}/g, "}")
        : l,
    )
    .join("\n")
}

function parseBookSection(section: string, bookId: string): UsfmBookResult {
  const lines = normalizeAlignedUsfm(unwrapSelah(stripNotes(section))).split("\n")
  const strings: TranslatableString[] = []
  let chapter = 0
  // True only while the most recent cell is a verse of the CURRENT chapter: bare
  // continuation lines may append to a verse, never to a heading or across a \c.
  let verseOpen = false

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
    let trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith("\\id ")) continue

    const chapterMatch = trimmed.match(/^\\c\s+(\d+)/)
    if (chapterMatch) {
      chapter = parseInt(chapterMatch[1])
      verseOpen = false
      continue
    }

    // Poetry/paragraph-flow containers (plain USFM keeps them on the line): unwrap
    // the marker, then fall through — the remainder is either a mid-line "\v N"
    // start or continuation text appended to the open verse below.
    const container = trimmed.match(CONTAINER_MARKER)
    if (container) {
      trimmed = trimmed.slice(container[0].length).trim()
      if (!trimmed) continue
    }

    // Text is optional: aligned corpora (hbo_uhb) emit bare "\v N" lines whose
    // words arrive on the following lines and get appended below. Verse ranges
    // ("\v 1-2") keep the full range token in the ref.
    const verseMatch = trimmed.match(/^\\v\s+(\d+(?:-\d+)?)(?:\s+(.*))?$/)
    if (verseMatch) {
      // Normalize zero-padded verse numbers ("\v 01", "\v 01-02") so the ref —
      // which seeds deterministic DCS cell ids — is identical to "\v 1" / "\v 1-2".
      const verseNum = verseMatch[1]
        .split("-")
        .map((n) => String(parseInt(n, 10)))
        .join("-")
      const vref = `${bookId} ${chapter}:${verseNum}`
      addString(verseMatch[2] ?? "", vref, "verse", `${bookId} ${chapter}`, [vref])
      verseOpen = true
      continue
    }

    // \d — psalm superscription ("A psalm of David."): a heading, not verse text.
    // \qa — acrostic heading (the Hebrew letter names in Psalm 119): displayed text
    // that labels a stanza, not verse content — heading cell, same as \d.
    const descriptorMatch = trimmed.match(/^\\(?:d|qa)\s+(.*)/)
    if (descriptorMatch) {
      addString(descriptorMatch[1], `${bookId} ${chapter}`, "heading", `${bookId} ${chapter}`)
      verseOpen = false
      continue
    }

    const sectionMatch = trimmed.match(/^\\s\d?\s+(.*)/)
    if (sectionMatch) {
      addString(sectionMatch[1], `${bookId} ${chapter}`, "heading", `${bookId} ${chapter}`)
      verseOpen = false
      continue
    }

    if (/^\\p\s*$/.test(trimmed)) continue

    const paratextMatch = trimmed.match(/^\\(mt|ms|r)\d?\s+(.*)/)
    if (paratextMatch) {
      addString(paratextMatch[2], bookId, "paratext", `${bookId} intro`)
      verseOpen = false
      continue
    }

    if (!trimmed.startsWith("\\")) {
      if (verseOpen && strings.length > 0) {
        // Continuation of the open verse (plain-USFM \q/\p flow across lines).
        const last = strings[strings.length - 1]
        last.original = last.original ? last.original + " " + trimmed : trimmed
      } else if (chapter > 0) {
        // Text-bearing container line before any \v in the chapter (e.g. "\q1 words"
        // right after "\c 5" or a \s heading): it must NOT mutate the previous cell —
        // emit it as a chapter-scoped text cell instead.
        addString(trimmed, `${bookId} ${chapter}`, "text", `${bookId} ${chapter}`)
      }
    }
  }

  return { bookId, strings }
}
