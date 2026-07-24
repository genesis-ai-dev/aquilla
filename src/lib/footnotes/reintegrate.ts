/**
 * Reassemble a completion-model reply into cell text with real USFM footnotes.
 *
 * The prompt side (completion.ts) decomposes a footnoted source into base text
 * with `[n]` callers plus a footnote block, and asks the model to reply with
 * the translated base (markers kept in place) followed by one `[n] <text>`
 * line per footnote. This module parses that reply and rebuilds the raw
 * `\f...\f*` spans so the committed target carries actual footnotes — not
 * `[n]` placeholder text — and stays round-trippable through the lossless
 * serializer and editable in the footnote tray.
 *
 * Failure posture: a footnote must never be silently lost. A missing `[n]`
 * reply line falls back to the untranslated source note text; a caller the
 * model dropped from the base gets its marker appended at the end of the text.
 * Both degradations are reported so the caller can log them. Only an empty
 * translated base is unrecoverable (`text: null`) — the caller must treat that
 * as "no translation" and not commit (D11 never-commit-empty).
 */

import type { ExtractedFootnote } from "./extract"
import { sanitizeFootnoteField } from "./insert"
import { updateFootnoteRaw } from "./splice"

export interface FootnoteReintegration {
  /** Reintegrated plain text with real `\f...\f*` markers, or null when the
   *  translated base is empty (caller must treat as an empty result). */
  text: string | null
  /** 1-based ns whose `[n]` reply line was absent from the model output
   *  (source note text used as fallback so the marker stays valid). */
  missingNoteLines: number[]
  /** 1-based ns whose `[n]` caller was absent from the translated base
   *  (marker appended at the end of the base instead). */
  appendedCallers: number[]
}

/**
 * A trailing footnote-reply line: `[n] text`, tolerating an echoed `(ref)`
 * after the marker (the prompt's footnote block shows `[1] (1:1) note`, and
 * models echo the ref back). Requiring non-empty text after the marker means
 * a bare `[1]` line — the translated base of a footnote-only cell — is NOT
 * consumed as a footnote line.
 */
const NOTE_LINE_RE = /^\s*\[(\d+)\]\s*(?:\([^)]*\)\s*)?(\S[\s\S]*)$/

/**
 * Parse the model reply for a footnoted source and rebuild real USFM markers.
 * `notes` are the source cell's extracted footnotes in document order
 * (notes[i] ↔ caller [i+1]) — each rebuilt span preserves that note's caller
 * and `\fr` reference scaffolding verbatim (updateFootnoteRaw).
 */
export function reintegrateFootnotes(
  modelOutput: string,
  notes: ExtractedFootnote[],
): FootnoteReintegration {
  const lines = modelOutput.trim().split("\n")

  // Collect trailing `[n] text` lines bottom-up. Walking upward and letting
  // later map-sets overwrite means a duplicated [n] resolves to the occurrence
  // closest to the base — the first one the model emitted. A line whose n is
  // out of range for the source's notes is base content (e.g. a verse
  // numeral), so it ends the trailing block rather than being consumed.
  const translatedNotes = new Map<number, string>()
  let end = lines.length
  while (end > 0) {
    const m = NOTE_LINE_RE.exec(lines[end - 1])
    if (!m) break
    const n = Number(m[1])
    if (n < 1 || n > notes.length) break
    translatedNotes.set(n, m[2].trim())
    end -= 1
  }

  const base = lines.slice(0, end).join("\n").trim()
  if (!base) return { text: null, missingNoteLines: [], appendedCallers: [] }

  const missingNoteLines = notes
    .map((_, i) => i + 1)
    .filter((n) => !translatedNotes.has(n))

  // Model output is untrusted: sanitize it so a stray backslash can't corrupt
  // the rebuilt span. The fallback (source note text) is already valid cell
  // content and is used as-is.
  const rebuiltMarker = (n: number): string => {
    const translated = translatedNotes.get(n)
    return updateFootnoteRaw(
      notes[n - 1].raw,
      translated !== undefined ? sanitizeFootnoteField(translated) : notes[n - 1].text,
    )
  }

  // Single pass over the base: the first occurrence of each in-range [n]
  // becomes its rebuilt marker, repeats are stripped, out-of-range tokens are
  // left untouched. One replace() call means inserted note text containing a
  // bracketed number can never itself be re-scanned.
  const used = new Set<number>()
  let strippedRepeat = false
  let text = base.replace(/\[(\d+)\]/g, (token, d: string) => {
    const n = Number(d)
    if (n < 1 || n > notes.length) return token
    if (used.has(n)) {
      strippedRepeat = true
      return ""
    }
    used.add(n)
    return rebuiltMarker(n)
  })
  // Stripping a repeated caller can leave a doubled space behind.
  if (strippedRepeat) text = text.replace(/[ \t]{2,}/g, " ").trim()

  // Callers the model dropped from the base: append their markers so the
  // footnotes still survive the round-trip (slightly misplaced beats lost —
  // the cell stays fully editable via the footnote tray).
  const appendedCallers: number[] = []
  for (let n = 1; n <= notes.length; n++) {
    if (used.has(n)) continue
    appendedCallers.push(n)
    text += ` ${rebuiltMarker(n)}`
  }

  return { text, missingNoteLines, appendedCallers }
}
