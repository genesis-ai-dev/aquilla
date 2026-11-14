// USFM notes parked beside a content-only cell, and how they get back into an
// exported file (AQU-1295).
//
// The Agent API's `agent:usfm` profile imports content-only (AQU-1283): the
// footnotes, endnotes and cross-references are lifted out of the verse text and
// stored in `cells.metadata.usfmNotes`, so an agent drafting from `value` never
// sees a marker. Export then substitutes the translated `value` into the
// preserved original, which replaces the whole verse span — markers and all.
//
// For an UNtranslated verse that is harmless: no override, so the original span
// (notes included) is emitted verbatim. For a TRANSLATED verse the notes were
// silently dropped, which is how 294 notes went missing from Biblica's NRT Acts
// at print time. This module is the other half of the round-trip: the exporter
// re-attaches a verse's own notes to its translation.
//
// They are re-attached at the END of the verse rather than at their original
// character offset. A translation is a different length — often a different
// word order — so the source offset addresses nothing meaningful in it, and a
// note landing mid-word is worse than a note landing late. Verse-end is the
// compromise the ticket records; moving a note to its right place inside a
// translated verse needs a translator, which is option A and a different
// ticket.

/** A footnote/endnote/crossref lifted out of a content-only USFM cell and kept
 *  in `metadata.usfmNotes` (AQU-1283).
 *
 *  `raw` is the note's original span, captured at import so export can restore
 *  it byte-for-byte. It is optional because files imported before AQU-1295 have
 *  records without it; those are rebuilt from the parsed fields instead, which
 *  is faithful in content but not necessarily byte-identical. */
export interface UsfmNoteRecord {
  kind: 'footnote' | 'endnote' | 'xref'
  caller: string
  ref: string
  text: string
  raw?: string
}

/** Opening marker and origin-reference marker per note kind. */
const NOTE_MARKERS: Record<UsfmNoteRecord['kind'], { note: string; origin: string; body: string }> = {
  footnote: { note: 'f', origin: 'fr', body: 'ft' },
  endnote: { note: 'fe', origin: 'fr', body: 'ft' },
  xref: { note: 'x', origin: 'xo', body: 'xt' },
}

/** Any note-family opener. Used to spot a translation that already carries its
 *  own notes, so re-insertion never duplicates them. */
const NOTE_OPENER_RE = /\\(?:f|fe|ef|x|ex)\s/

function isNoteRecord(value: unknown): value is UsfmNoteRecord {
  if (typeof value !== 'object' || value === null) return false
  const n = value as Record<string, unknown>
  return (
    (n.kind === 'footnote' || n.kind === 'endnote' || n.kind === 'xref') &&
    typeof n.text === 'string'
  )
}

/** Read `usfmNotes` out of a cell's metadata column.
 *
 *  The column is JSONB, but the D1-compatible shim hands it back as either a
 *  parsed object or the raw JSON string depending on the driver, and a cell's
 *  metadata is caller-supplied in the first place — so every shape that is not
 *  a well-formed note list degrades to "this cell has no notes" rather than
 *  failing the export. */
export function readUsfmNotes(metadata: unknown): UsfmNoteRecord[] {
  let parsed: unknown = metadata
  if (typeof parsed === 'string') {
    if (parsed.trim() === '') return []
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return []
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const notes = (parsed as Record<string, unknown>).usfmNotes
  if (!Array.isArray(notes)) return []
  return notes.filter(isNoteRecord)
}

/** Rebuild one note's USFM span.
 *
 *  Prefers the `raw` captured at import. Without it, assemble the standard
 *  shape — `\f + \fr 1:4 \ft body\f*` — from the parsed fields. An empty caller
 *  becomes `+` (auto), which is what a file omitting it means; an empty origin
 *  ref drops the `\fr`/`\xo` rather than emitting a bare marker. */
export function serializeUsfmNote(note: UsfmNoteRecord): string {
  if (typeof note.raw === 'string' && note.raw.trim() !== '') return note.raw
  const m = NOTE_MARKERS[note.kind]
  const caller = note.caller.trim() === '' ? '+' : note.caller.trim()
  const origin = note.ref.trim() === '' ? '' : `\\${m.origin} ${note.ref.trim()} `
  return `\\${m.note} ${caller} ${origin}\\${m.body} ${note.text}\\${m.note}*`
}

/**
 * Append a content-only cell's parked notes to its translated text.
 *
 * Returns `translation` unchanged when there is nothing to do: no notes, an
 * empty translation (the serializer reads that as "fall back to the original",
 * which already carries the notes), or a translation that already contains
 * note markers of its own — a translator who carried the notes across must not
 * end up with two copies.
 */
export function reattachUsfmNotes(translation: string, notes: readonly UsfmNoteRecord[]): string {
  if (notes.length === 0) return translation
  if (translation.trim() === '') return translation
  if (NOTE_OPENER_RE.test(translation)) return translation
  const spans = notes.map(serializeUsfmNote).filter((s) => s.trim() !== '')
  if (spans.length === 0) return translation
  // Keep the translation's own trailing whitespace outside the notes: the
  // serializer uses the last character to decide whether it must add a newline
  // before the next marker, and a note span ends in `*`, not in space.
  const trailing = /\s*$/.exec(translation)?.[0] ?? ''
  const body = translation.slice(0, translation.length - trailing.length)
  return `${body} ${spans.join(' ')}${trailing}`
}
