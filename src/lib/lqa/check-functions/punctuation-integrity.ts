import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Clause punctuation from source missing in translation"

// Structural, clause-level marks that carry meaning and are normally preserved
// across a translation. Terminal .?! are handled by end-punctuation-mismatch;
// this catches *mid-cell* drops — e.g. a source ":" flattened to a "." in the
// target, which the end-only check never sees (AQU-587).
const MARKS = [":", ";"] as const

// Fold the full-width CJK variants onto their ASCII form so a target that
// localizes ":" as "：" still counts the mark as present. The mapping is
// character-for-character, so offsets into the folded string match the original.
function fold(text: string): string {
  return text.replace(/：/g, ":").replace(/；/g, ";")
}

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const foldedSource = fold(source)
  const foldedTarget = fold(target)
  const spans: InfractionSpan[] = []

  for (const mark of MARKS) {
    if (!foldedSource.includes(mark)) continue // source doesn't use this mark
    if (foldedTarget.includes(mark)) continue // target preserves it somewhere
    // Present in source, entirely absent from target → flag every occurrence so
    // a cell that drops several marks surfaces several spans, not just one.
    for (let i = 0; i < foldedSource.length; i++) {
      if (foldedSource[i] !== mark) continue
      spans.push({ side: "source", start: i, end: i + 1, matchedText: source[i] })
    }
  }

  return spans.length > 0 ? spans : null
}
