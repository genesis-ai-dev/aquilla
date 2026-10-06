// bible-examples — few-shot examples chosen by pack features (AQU-1690).
//
// Without Bible data the drafter sees the first validated pairs in file order
// (tick.ts used to take `slice(0, 10)`). With it, the validated pairs most
// like the span come first: the same speaker (a voice is worded the same way
// across a book), the same quotation shape (how this project marks a quote
// that opens and closes in one verse, or one nested inside another), and the
// same participants. Ties keep file order. When no validated pair shares any
// feature with the span — or there are no facts — the old file-order choice
// stands, so a project without Bible data drafts exactly as before.

import type { CellPair } from "../agent/tools/select-cells"
import type { CellFacts } from "../../../../db/shared/bible-facts/types"
import type { ExamplePair } from "./draft"

const SPEAKER_WEIGHT = 3
const SHAPE_WEIGHT = 2
const PARTICIPANT_WEIGHT = 1

/** How a cell's quotations are laid out, e.g. "1oc" (level 1 opens and closes) or "1oc+2oc"; "none" for narration. */
export function quoteShape(facts: CellFacts): string {
  const marked = facts.speeches.filter((s) => s.level >= 1 && !s.selfProjected)
  if (marked.length === 0) return "none"
  return marked.map((s) => `${s.level}${s.opens ? "o" : ""}${s.closes ? "c" : ""}`).join("+")
}

interface Features {
  speakers: Set<string>
  shapes: Set<string>
  participants: Set<string>
}

function featuresOf(facts: CellFacts | undefined): Features {
  return {
    speakers: new Set(facts?.speeches.flatMap((s) => (s.speaker ? [s.speaker.id] : [])) ?? []),
    shapes: new Set(facts ? [quoteShape(facts)] : []),
    participants: new Set(facts?.participants.map((p) => p.id) ?? []),
  }
}

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0
  for (const x of a) if (b.has(x)) n += 1
  return n
}

function asExample(p: CellPair): ExamplePair {
  return { cellId: p.cellId, source: p.source, target: p.target, validated: true }
}

/**
 * Up to `target` validated pairs for the drafter, ranked by features shared
 * with `span`; the first `target` in file order when no pair shares any.
 */
export function examplesForSpan(
  pairs: readonly CellPair[],
  span: readonly CellPair[],
  target: number,
  facts?: ReadonlyMap<string, CellFacts>,
): ExamplePair[] {
  const validated = pairs.filter((p) => p.validated && p.target.trim())
  const inFileOrder = () => validated.slice(0, target).map(asExample)
  if (!facts || facts.size === 0) return inFileOrder()

  const want: Features = { speakers: new Set(), shapes: new Set(), participants: new Set() }
  for (const p of span) {
    const f = featuresOf(facts.get(p.cellId))
    f.speakers.forEach((x) => want.speakers.add(x))
    f.shapes.forEach((x) => want.shapes.add(x))
    f.participants.forEach((x) => want.participants.add(x))
  }
  const scored = validated.map((p, order) => {
    const f = featuresOf(facts.get(p.cellId))
    const score =
      SPEAKER_WEIGHT * overlap(f.speakers, want.speakers) +
      // "none" (narration) is shared by most of a book; it is not a signal.
      SHAPE_WEIGHT * overlap(new Set([...f.shapes].filter((s) => s !== "none")), want.shapes) +
      PARTICIPANT_WEIGHT * overlap(f.participants, want.participants)
    return { p, order, score }
  })
  if (!scored.some((s) => s.score > 0)) return inFileOrder()
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, target)
    .sort((a, b) => a.order - b.order)
    .map((s) => asExample(s.p))
}
