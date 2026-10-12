// AQU-1679: the line pairing behind "replace the source in my existing file".
//
// Both workers run this one function — auth-worker to say what a replace will
// do, sync-worker to do it — so what it pairs IS the feature: a wrong pair puts
// a translation under source text it was not made from. These tests pin the
// rules it pairs by, and above all the cases where it must pair nothing.

import { describe, it, expect } from "vitest"
import {
  canReplaceWith,
  matchLinkedFileLines,
  orderCellsByAnchor,
  type MatchLine,
} from "./link-file-match"

const lines = (prefix: string, values: readonly string[]): MatchLine[] =>
  values.map((value, i) => ({ cellId: `${prefix}${i + 1}`, value }))

const pairsOf = (upstream: readonly string[], local: readonly string[]) =>
  matchLinkedFileLines(lines("u", upstream), lines("l", local)).pairs.map(
    (p) => `${p.upstreamCellId}=${p.cellId}${p.same ? "" : "*"}`,
  )

describe("matchLinkedFileLines", () => {
  // WHY: the case the option exists for — one file imported twice. Every line
  // must pair, in order, including the blank and repeated ones that carry no
  // identity of their own.
  it("pairs every line of the same material, blank and repeated lines included", () => {
    const text = ["Title", "", "Selah", "A verse", "Selah", "", "Another verse"]
    const match = matchLinkedFileLines(lines("u", text), lines("l", text))

    expect(match.pairs.map((p) => `${p.upstreamCellId}=${p.cellId}`)).toEqual([
      "u1=l1", "u2=l2", "u3=l3", "u4=l4", "u5=l5", "u6=l6", "u7=l7",
    ])
    expect(match).toMatchObject({ same: 7, changed: 0, added: 0, kept: 0, canReplace: true })
  })

  // WHY: an edited line has no text in common with its counterpart, but it sits
  // between two lines that do. Leaving it unpaired would add the upstream's
  // version as a new line next to the translated old one.
  it("pairs a reworded line with its counterpart by position", () => {
    expect(pairsOf(["a", "b fixed", "c"], ["a", "b", "c"])).toEqual(["u1=l1", "u2=l2*", "u3=l3"])
  })

  // WHY: an insertion or a removal must not shift every later pair by one.
  it("leaves a line only one side has unpaired and keeps the rest aligned", () => {
    const added = matchLinkedFileLines(lines("u", ["a", "new", "b", "c"]), lines("l", ["a", "b", "c"]))
    expect(added.pairs.map((p) => `${p.upstreamCellId}=${p.cellId}`)).toEqual(["u1=l1", "u3=l2", "u4=l3"])
    expect(added).toMatchObject({ same: 3, added: 1, kept: 0 })

    const kept = matchLinkedFileLines(lines("u", ["a", "b", "c"]), lines("l", ["a", "note", "b", "c"]))
    expect(kept.pairs.map((p) => `${p.upstreamCellId}=${p.cellId}`)).toEqual(["u1=l1", "u2=l3", "u3=l4"])
    expect(kept).toMatchObject({ same: 3, added: 0, kept: 1 })
  })

  // WHY: where the two sides disagree about how many lines there are, which
  // line became which is a guess — and a wrong guess silently re-homes a
  // translation. Nothing in such a run is paired.
  it("pairs nothing across a run that is longer on one side", () => {
    expect(pairsOf(["a", "x", "y", "c"], ["a", "b", "c"])).toEqual(["u1=l1", "u4=l3"])
  })

  // WHY: a repeated line is not evidence of position. Anchoring on it would let
  // one stray "Selah" drag the whole alignment sideways.
  it("anchors on text that occurs once, not on repeated lines", () => {
    expect(
      pairsOf(["Selah", "one", "Selah", "two"], ["extra", "Selah", "one", "Selah", "two"]),
    ).toEqual(["u1=l2", "u2=l3", "u3=l4", "u4=l5"])
  })

  // WHY: importers reflow whitespace; that must not break the alignment. But
  // `same` is a promise that the line does not change, so it stays exact.
  it("aligns across whitespace differences but does not call the lines the same", () => {
    const match = matchLinkedFileLines(lines("u", ["In  the beginning "]), lines("l", ["In the beginning"]))
    expect(match.pairs).toEqual([{ upstreamCellId: "u1", cellId: "l1", same: false }])
    expect(match).toMatchObject({ same: 0, changed: 1 })
  })

  // WHY: two files that merely share a name and a length would otherwise pair
  // line for line "by position" and overwrite a whole source.
  it("reports unrelated files as not replaceable", () => {
    const match = matchLinkedFileLines(
      lines("u", ["one", "two", "three"]),
      lines("l", ["uno", "dos", "tres"]),
    )
    expect(match).toMatchObject({ same: 0, changed: 3, canReplace: false })
  })

  it("handles an empty file on either side", () => {
    expect(matchLinkedFileLines([], lines("l", ["a"]))).toMatchObject({ pairs: [], kept: 1, canReplace: false })
    expect(matchLinkedFileLines(lines("u", ["a"]), [])).toMatchObject({ pairs: [], added: 1, canReplace: false })
  })

  // WHY: a whole Bible in one file is ~31k lines. The pairing runs inside a
  // request, so it has to stay near-linear on the shape real files have.
  it("pairs a large, lightly edited file without quadratic work", () => {
    const upstream = Array.from({ length: 30_000 }, (_, i) => `verse ${i}`)
    const local = upstream.filter((_, i) => i % 1000 !== 500)
    local[10] = "verse ten, reworded"
    const match = matchLinkedFileLines(lines("u", upstream), lines("l", local))
    expect(match).toMatchObject({ same: 29_969, changed: 1, added: 30, kept: 0, canReplace: true })
  })
})

describe("canReplaceWith", () => {
  it("needs at least half of the longer file to be word-for-word the same", () => {
    expect(canReplaceWith(5, 10, 8)).toBe(true)
    expect(canReplaceWith(4, 10, 8)).toBe(false)
    expect(canReplaceWith(4, 4, 10)).toBe(false)
    expect(canReplaceWith(0, 0, 0)).toBe(false)
  })
})

describe("orderCellsByAnchor", () => {
  it("walks the anchor chain, and keeps cells a broken chain cannot reach", () => {
    const ordered = orderCellsByAnchor([
      { cellId: "c", anchorCellId: "b" },
      { cellId: "a", anchorCellId: null },
      { cellId: "orphan", anchorCellId: "missing" },
      { cellId: "b", anchorCellId: "a" },
    ])
    expect(ordered.map((c) => c.cellId)).toEqual(["a", "b", "c", "orphan"])
  })
})
