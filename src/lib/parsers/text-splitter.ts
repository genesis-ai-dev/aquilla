import { v4 as uuid } from "uuid"
import type { CellUnit } from "./core-types"

// Paragraph is a GROUPING over cells, never a re-segmentation of them. For aligned
// corpora (USFM) the verse-cell is the alignment unit and must NOT be split below —
// the alignment/BT/terminology stack depends on source↔target cell correspondence.
// See docs/superpowers/specs/2026-06-18-paragraph-drafting-retrieval-context-design.md (D1,D2).

// Every cut matches whitespace only (or nothing, after an unspaced dash): the
// punctuation stays on the preceding segment through a lookbehind, so joining
// segments with one space gives back the paragraph (AQU-1469).
const BREAK_PATTERNS: RegExp[] = [
  /\n\n+/,                     // paragraph
  /\n/,                        // line
  /(?<=[.!?])\s+/,             // sentence
  /(?<=[;:])\s+/,              // clause
  /(?<=,)\s+/,                 // comma
  /(?<=[—–])\s*|(?<=\s-)\s+/,  // dash
  /\s+/,                       // word
]

export function splitIntoSegments(
  text: string,
  maxLength = 200,
  cellUnit: CellUnit = "sentence",
): { text: string; group: string }[] {
  const group = uuid()

  // AQU-1720: in paragraph mode the paragraph IS the cell — no sentence split
  // and no length cap, so a 400-character block stays one dubbing clip instead
  // of being chopped at a comma. The group is still minted so the segment
  // contract (one group per source paragraph) holds in both modes.
  if (cellUnit === "paragraph" || text.length <= maxLength) {
    return [{ text, group }]
  }

  return recursiveSplit(text, maxLength, 0).map((t) => ({ text: t, group }))
}

function recursiveSplit(text: string, maxLength: number, level: number): string[] {
  if (text.length <= maxLength || level >= BREAK_PATTERNS.length) {
    return [text]
  }

  // The capture group keeps each cut in the result, so the merge below can tell
  // a whitespace cut (rejoined with one space) from an unspaced dash (rejoined
  // with nothing, "a—b" stays "a—b").
  const pieces = text.split(new RegExp(`(${BREAK_PATTERNS[level].source})`))
  const parts: { text: string; spaced: boolean }[] = []
  for (let i = 0; i < pieces.length; i += 2) {
    if (pieces[i].trim().length === 0) continue
    parts.push({ text: pieces[i], spaced: i > 0 && pieces[i - 1] !== "" })
  }

  if (parts.length <= 1) {
    return recursiveSplit(text, maxLength, level + 1)
  }

  const merged: string[] = []
  let current = parts[0].text

  for (let i = 1; i < parts.length; i++) {
    const combined = current + (parts[i].spaced ? " " : "") + parts[i].text
    if (combined.length <= maxLength) {
      current = combined
    } else {
      merged.push(current)
      current = parts[i].text
    }
  }
  merged.push(current)

  return merged.flatMap((chunk) =>
    chunk.length > maxLength ? recursiveSplit(chunk, maxLength, level + 1) : [chunk]
  )
}

export function mergeSegments(segments: { text: string; group: string }[]): string {
  return segments.map((s) => s.text).join(" ")
}
