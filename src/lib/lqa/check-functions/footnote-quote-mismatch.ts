import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Footnote quote not found in the verse text"

/**
 * AQU-1736 — Paratext parity: "Footnote Quotes" (formerly "Quoted text").
 *
 * A footnote or cross-reference that quotes the verse it hangs on (`\fq`,
 * `\fk`, `\xq`, `\xk`) must quote text that is actually there. The quote is
 * checked against the verse text of the SAME cell with every note removed —
 * never against the source, which is a different language. Editing the verse
 * so a quote no longer matches therefore flags the note on the next
 * evaluation (the rule engine re-checks the edited cell per keystroke batch).
 *
 * Deliberately NOT checked: `\fqa` / `\xta` (alternative rendering / target
 * translation of the reference), which are meant to differ from the verse;
 * and the `\ft` note body itself, which is prose about the verse, not a quote.
 *
 * Matching is intentionally forgiving — Paratext's check is a plain
 * "does this text occur in the verse" test, and a false positive on a clean
 * note is worse than a missed one. We normalize away case, punctuation,
 * inline character markers and whitespace runs, honour `…` elision inside a
 * quote (each piece must occur, in order), and bail out entirely on a cell
 * whose only content is notes (nothing to verify against).
 */

/** Footnote (`\f … \f*`) and cross-reference (`\x … \x*`) wrappers. */
const NOTE_RE = /\\([fx])[ \t]+([^\s\\]+)([\s\S]*?)\\\1\*/g

/**
 * Note field markers, longest-prefix-first so `\fqa` is never half-matched as
 * `\fq` (the trap `src/lib/footnotes/splice.ts` documents).
 */
const FIELD_RE = /\\(fqa|fq|fdc|fr|ft|fk|fl|fv|fp|fm|xot|xnt|xdc|xop|xta|xo|xt|xq|xk)[ \t]+/g

/** The fields that quote the verse, and so must be found in it. */
const QUOTE_FIELDS = new Set(["fq", "fk", "xq", "xk"])

/** A field's own closing marker, e.g. the `\fq*` ending `\fq quote\fq*`. */
const CLOSING_MARKER_RE = /\\[a-z]+\*\s*$/i

/** `…` or `...` inside a quote marks elided verse text. */
const ELISION_RE = /…|\.\s*\.\s*\./

interface NoteSpan { start: number; end: number; body: string; bodyStart: number }

function findNotes(text: string): NoteSpan[] {
  const out: NoteSpan[] = []
  const re = new RegExp(NOTE_RE.source, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const body = m[3] ?? ""
    // The body is captured immediately before the 3-character closing marker.
    const bodyStart = m.index + m[0].length - 3 - body.length
    out.push({ start: m.index, end: m.index + m[0].length, body, bodyStart })
  }
  return out
}

interface QuoteField { value: string; start: number }

function quoteFields(note: NoteSpan): QuoteField[] {
  const re = new RegExp(FIELD_RE.source, "g")
  const markers = Array.from(note.body.matchAll(re))
  const out: QuoteField[] = []
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]
    if (marker.index === undefined) continue
    if (!QUOTE_FIELDS.has(marker[1])) continue
    const valueStart = marker.index + marker[0].length
    const valueEnd = markers[i + 1]?.index ?? note.body.length
    // `\fq quote\fq*` closes its own field; drop that closing marker so the
    // highlighted span is the quote itself, not the markup around it.
    const raw = note.body.slice(valueStart, valueEnd).replace(CLOSING_MARKER_RE, "")
    const lead = raw.length - raw.trimStart().length
    const value = raw.trim()
    if (!value) continue
    out.push({ value, start: note.bodyStart + valueStart + lead })
  }
  return out
}

/** The cell's text with every note removed — the verse a quote must occur in. */
function verseTextOutsideNotes(text: string, notes: NoteSpan[]): string {
  let out = ""
  let cursor = 0
  for (const note of notes) {
    out += text.slice(cursor, note.start) + " "
    cursor = note.end
  }
  return out + text.slice(cursor)
}

/**
 * Fold away everything a faithful quote is allowed to differ by: inline
 * character markers (`\bd …\bd*`), case, punctuation (quote marks, the elision
 * ellipsis, trailing stops) and whitespace runs.
 */
function normalize(text: string): string {
  return text
    .replace(/\\[a-z]+\d*\*?/gi, " ")
    .normalize("NFC")
    .toLowerCase()
    .replace(/\p{P}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
}

/** True when `quote`'s pieces all occur in `verse`, in order. */
function quoteOccursIn(quote: string, verse: string): boolean {
  const pieces = quote.split(ELISION_RE).map(normalize).filter(Boolean)
  if (pieces.length === 0) return true // nothing quotable survived normalization
  let cursor = 0
  for (const piece of pieces) {
    const at = verse.indexOf(piece, cursor)
    if (at === -1) return false
    cursor = at + piece.length
  }
  return true
}

export function runCheck(_source: string, target: string): InfractionSpan[] | null {
  if (!target.includes("\\")) return null // no USFM markers at all
  const notes = findNotes(target)
  if (notes.length === 0) return null

  const verse = normalize(verseTextOutsideNotes(target, notes))
  if (!verse) return null // notes only — no verse text to check the quote against

  const spans: InfractionSpan[] = []
  for (const note of notes) {
    for (const field of quoteFields(note)) {
      if (quoteOccursIn(field.value, verse)) continue
      spans.push({
        side: "target",
        start: field.start,
        end: field.start + field.value.length,
        matchedText: field.value,
      })
    }
  }

  return spans.length > 0 ? spans : null
}
