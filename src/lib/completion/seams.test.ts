import { describe, it, expect } from "vitest"
import {
  combineSeam,
  deriveDraftingUnits,
  draftingUnitForCell,
  heuristicJoin,
  packUnitsIntoCalls,
  seamKey,
  DEFAULT_SEAM_THRESHOLDS,
  type DraftingUnit,
  type SeamAnswers,
  type SeamCell,
  type SeamDecision,
} from "./seams"

// A confident, unambiguous "these two cells are one sentence".
const CONTINUES: SeamAnswers = {
  continues_sentence: 0.94,
  same_item: 0.2,
  refers_back: 0.3,
  section_break: 0.03,
  boundary_level: { level: 0 },
}

// A confident, unambiguous "a new exercise starts here".
const NEW_SECTION: SeamAnswers = {
  continues_sentence: 0.05,
  same_item: 0.1,
  refers_back: 0.08,
  section_break: 0.96,
  boundary_level: { level: 3 },
}

describe("seamKey", () => {
  it("keys a seam on the source event ids of BOTH sides", () => {
    expect(seamKey("evt-a", "evt-b")).toBe("evt-a~evt-b")
  })

  it("is direction-sensitive — a seam is an ordered pair, not a set", () => {
    // (A,B) and (B,A) are different seams in a reordered file; sharing a key
    // would serve one seam's answers for the other.
    expect(seamKey("evt-a", "evt-b")).not.toBe(seamKey("evt-b", "evt-a"))
  })

  it("returns null when either side has no source event yet", () => {
    // A locally-created cell that the server has not acked has no stable
    // identity. Minting a key from it would cache an answer under something
    // that changes on ack, so the seam is simply not cacheable.
    expect(seamKey(null, "evt-b")).toBeNull()
    expect(seamKey("evt-a", undefined)).toBeNull()
  })

  it("changes for exactly the two seams touching an edited cell", () => {
    // This is the whole invalidation story: nothing walks the file marking
    // entries stale — editing B mints a new event id, which changes the (A,B)
    // and (B,C) keys and leaves (C,D) hitting the cache.
    const before = ["a", "b", "c", "d"]
    const after = ["a", "b2", "c", "d"]
    const keysOf = (ids: string[]) =>
      ids.slice(0, -1).map((id, i) => seamKey(id, ids[i + 1]))

    const changed = keysOf(before).filter((k, i) => k !== keysOf(after)[i])
    expect(changed).toHaveLength(2)
  })
})

describe("heuristicJoin — the deterministic fallback", () => {
  it("joins when the previous cell ends mid-sentence", () => {
    // The canonical EBL failure: "…he said" continues into the next cell.
    expect(heuristicJoin("And when he had finished speaking, he said")).toBe(true)
    expect(heuristicJoin("Jesus said to them,")).toBe(true)
  })

  it("breaks when the previous cell ends a sentence", () => {
    expect(heuristicJoin("He went home.")).toBe(false)
    expect(heuristicJoin("Who can this be?")).toBe(false)
    expect(heuristicJoin("Rejoice!")).toBe(false)
  })

  it("sees through closing quotes and brackets to the punctuation beneath", () => {
    // Reported speech is the most common sentence end in translated scripture;
    // treating the closing quote itself as "no punctuation" would join every
    // quotation to whatever follows it.
    expect(heuristicJoin('He said, "Go now."')).toBe(false)
    expect(heuristicJoin("(so it was written.)")).toBe(false)
    expect(heuristicJoin("彼は言った。」")).toBe(false)
  })

  it("joins when only a closing quote follows an unfinished clause", () => {
    expect(heuristicJoin('and he said "')).toBe(true)
  })

  it("treats an ellipsis or a dangling dash as a continuation, not a full stop", () => {
    // These are continuation marks. A trailing "…" is exactly the mid-thought
    // split this feature exists to catch, so the period inside it must not
    // count as sentence-final.
    expect(heuristicJoin("but as for me...")).toBe(true)
    expect(heuristicJoin("but as for me…")).toBe(true)
    expect(heuristicJoin("and then—")).toBe(true)
  })

  it("does not join an empty or whitespace-only cell", () => {
    // There is no thought to continue, so grouping would only enlarge the call.
    expect(heuristicJoin("")).toBe(false)
    expect(heuristicJoin("   \n ")).toBe(false)
  })

  it("recognises non-Latin sentence-final punctuation", () => {
    expect(heuristicJoin("他回家了。")).toBe(false)
    expect(heuristicJoin("वह घर गया।")).toBe(false)
  })
})

describe("combineSeam — the combine rule", () => {
  it("joins on a confident continuation with no section break", () => {
    const d = combineSeam(CONTINUES, "he said")
    expect(d.join).toBe(true)
    expect(d.decidedBy).toBe("model")
    expect(d.joinProbability).toBeCloseTo(0.94 * 0.97, 5)
  })

  it("lets ANY ONE of the three belonging signals carry the OR", () => {
    // The three are alternatives, not evidence to be averaged: a list item
    // split across cells has no incomplete sentence and no back-reference, and
    // must still group. Averaging would drown a single decisive signal.
    const sameItemOnly: SeamAnswers = {
      continues_sentence: 0.05,
      same_item: 0.93,
      refers_back: 0.05,
      section_break: 0.04,
    }
    expect(combineSeam(sameItemOnly, "5.").join).toBe(true)
  })

  it("lets a confident section break veto an otherwise strong join", () => {
    // A new exercise that opens with a pronoun trips refers_back. Without the
    // veto we would glue exercise 6 onto the tail of exercise 5 — grouping that
    // looks like a bug to the translator.
    const strongButBroken: SeamAnswers = {
      continues_sentence: 0.1,
      same_item: 0.2,
      refers_back: 0.91,
      section_break: 0.95,
    }
    const d = combineSeam(strongButBroken, "he said")
    expect(d.join).toBe(false)
    expect(d.decidedBy).toBe("model")
    expect(d.joinProbability).toBeLessThan(0.1)
  })

  it("breaks on a confident new section", () => {
    const d = combineSeam(NEW_SECTION, "He went home.")
    expect(d.join).toBe(false)
    expect(d.decidedBy).toBe("model")
  })

  it("falls back to the heuristic when the model is on the fence", () => {
    // An uncalibrated-looking answer is worse than punctuation. Gating is the
    // reason for using a probability model at all — if we were going to trust
    // 0.51 the same as 0.99 we could have asked for a boolean.
    const undecided: SeamAnswers = {
      continues_sentence: 0.52,
      same_item: 0.5,
      refers_back: 0.48,
      section_break: 0.5,
    }
    const joinable = combineSeam(undecided, "he said")
    expect(joinable.decidedBy).toBe("heuristic")
    expect(joinable.join).toBe(true) // no final punctuation → continuation

    const breakable = combineSeam(undecided, "He went home.")
    expect(breakable.decidedBy).toBe("heuristic")
    expect(breakable.join).toBe(false)
  })

  it("does NOT dilute a certain veto with an undecided OR", () => {
    // Confidence follows the boolean expression, not an average: the veto alone
    // decides a FALSE, so a certain section_break must clear the gate even when
    // the three belonging signals are useless.
    const certainBreak: SeamAnswers = {
      continues_sentence: 0.5,
      same_item: 0.5,
      refers_back: 0.5,
      section_break: 0.99,
    }
    const d = combineSeam(certainBreak, "he said")
    expect(d.decidedBy).toBe("model")
    expect(d.join).toBe(false)
  })

  it("requires BOTH sides confident before joining", () => {
    // A join is a conjunction (belongs AND not a break). Acting on a certain
    // "belongs" while the break question is a coin flip is how grouping runs
    // past a heading.
    const halfKnown: SeamAnswers = {
      continues_sentence: 0.99,
      same_item: 0.5,
      refers_back: 0.5,
      section_break: 0.5,
    }
    expect(combineSeam(halfKnown, "he said").decidedBy).toBe("heuristic")
  })

  it("falls back when the section-break question went unanswered", () => {
    // A missing veto is an unknown, never an implicit "no break".
    const noVeto: SeamAnswers = { continues_sentence: 0.97, same_item: 0.1, refers_back: 0.1 }
    expect(combineSeam(noVeto, "he said").decidedBy).toBe("heuristic")
  })

  it("falls back when none of the three belonging questions was answered", () => {
    expect(combineSeam({ section_break: 0.02 }, "he said").decidedBy).toBe("heuristic")
  })

  it("falls back when the call failed entirely", () => {
    // Null answers is the shape a failed/absent Jev call produces. Drafting
    // must keep working with zero added latency and no error surfaced.
    expect(combineSeam(null, "he said").decidedBy).toBe("heuristic")
    expect(combineSeam(undefined, "He went home.").join).toBe(false)
  })

  it("ignores out-of-range probabilities rather than trusting them", () => {
    // A malformed upstream payload must not be read as maximal certainty.
    const bogus = { continues_sentence: 4, same_item: -1, refers_back: NaN, section_break: 0.01 }
    expect(combineSeam(bogus as SeamAnswers, "he said").decidedBy).toBe("heuristic")
  })

  it("reports a heuristic decision at probability 1 or 0, never a fake middle", () => {
    // The heuristic is deterministic. Reporting it as 0.5 would let it win a
    // weakest-seam tie-break against a genuinely marginal model answer.
    expect(combineSeam(null, "he said").joinProbability).toBe(1)
    expect(combineSeam(null, "He went home.").joinProbability).toBe(0)
  })

  it("carries the boundary level through, including on a fallback", () => {
    // AQU-1387/AQU-1388 threshold these cached levels at 3 and 4. They are
    // stored even when the join decision came from the heuristic, so a later
    // consumer is not forced to re-classify the seam.
    expect(combineSeam(CONTINUES, "he said").boundaryLevel).toBe(0)
    expect(combineSeam(NEW_SECTION, "He went home.").boundaryLevel).toBe(3)
    const levelOnlyFallback: SeamAnswers = { boundary_level: { level: 4 } }
    const d = combineSeam(levelOnlyFallback, "He went home.")
    expect(d.decidedBy).toBe("heuristic")
    expect(d.boundaryLevel).toBe(4)
  })

  it("rejects a boundary level outside the defined 0–4 scale", () => {
    expect(combineSeam({ boundary_level: { level: 9 } }, "x").boundaryLevel).toBeNull()
  })

  it("honours a caller-supplied threshold", () => {
    const marginal: SeamAnswers = {
      continues_sentence: 0.8, same_item: 0.1, refers_back: 0.1, section_break: 0.1,
    }
    // 0.8 * 0.9 = 0.72
    expect(combineSeam(marginal, "he said", DEFAULT_SEAM_THRESHOLDS).join).toBe(true)
    expect(combineSeam(marginal, "he said", { join: 0.8, confidence: 0.4 }).join).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

const cell = (id: string, fileId = "f1"): SeamCell => ({ id, fileId, sourceEventId: `e-${id}` })

/** Resolver that joins exactly the seams named `${prev}->${next}`. */
function resolverJoining(joins: string[], strength = 0.9): (p: SeamCell, n: SeamCell) => SeamDecision {
  return (p, n) => {
    const join = joins.includes(`${p.id}->${n.id}`)
    return {
      join,
      joinProbability: join ? strength : 0.05,
      confidence: 1,
      decidedBy: "model",
      boundaryLevel: null,
    }
  }
}

describe("deriveDraftingUnits", () => {
  it("returns no units for no cells", () => {
    expect(deriveDraftingUnits([], resolverJoining([]))).toEqual([])
  })

  it("makes every cell its own unit when nothing joins", () => {
    const units = deriveDraftingUnits([cell("a"), cell("b"), cell("c")], resolverJoining([]))
    expect(units.map((u) => u.ids)).toEqual([["a"], ["b"], ["c"]])
  })

  it("runs joined seams together into one unit", () => {
    const units = deriveDraftingUnits(
      [cell("a"), cell("b"), cell("c"), cell("d")],
      resolverJoining(["a->b", "b->c"]),
    )
    expect(units.map((u) => u.ids)).toEqual([["a", "b", "c"], ["d"]])
  })

  it("records each internal seam's strength alongside the ids", () => {
    const units = deriveDraftingUnits(
      [cell("a"), cell("b"), cell("c")],
      resolverJoining(["a->b", "b->c"], 0.77),
    )
    // One fewer strength than ids — strengths describe the gaps, not the cells.
    expect(units[0].seamStrength).toEqual([0.77, 0.77])
    expect(units[0].seamStrength).toHaveLength(units[0].ids.length - 1)
  })

  it("never spans a file boundary, even when the resolver would join", () => {
    // Same reason gatherPrecedingContext refuses to cross one: the next file is
    // not discourse continuation, and a unit that spans files would send two
    // documents into one prompt.
    const cells = [cell("a", "f1"), cell("b", "f2")]
    const units = deriveDraftingUnits(cells, resolverJoining(["a->b"]))
    expect(units.map((u) => u.ids)).toEqual([["a"], ["b"]])
  })

  it("does not even ask about a cross-file seam", () => {
    const asked: string[] = []
    deriveDraftingUnits([cell("a", "f1"), cell("b", "f2")], (p, n) => {
      asked.push(`${p.id}->${n.id}`)
      return { join: true, joinProbability: 1, confidence: 1, decidedBy: "model", boundaryLevel: null }
    })
    expect(asked).toEqual([])
  })
})

describe("draftingUnitForCell", () => {
  const units = deriveDraftingUnits(
    [cell("a"), cell("b"), cell("c"), cell("d")],
    resolverJoining(["b->c"]),
  )

  it("expands a mid-unit cell to its whole unit", () => {
    // The single-cell sparkle contract: clicking `c` must draft `b` and `c`
    // together, or the result ends mid-sentence.
    expect(draftingUnitForCell(units, "c")?.ids).toEqual(["b", "c"])
    expect(draftingUnitForCell(units, "b")?.ids).toEqual(["b", "c"])
  })

  it("returns the singleton unit for an ungrouped cell", () => {
    expect(draftingUnitForCell(units, "a")?.ids).toEqual(["a"])
  })

  it("returns null for a cell that is not in any unit", () => {
    expect(draftingUnitForCell(units, "zz")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

const unit = (ids: string[], seamStrength: number[] = ids.slice(1).map(() => 0.9)): DraftingUnit =>
  ({ ids, seamStrength })

describe("packUnitsIntoCalls", () => {
  it("fills a call up to the budget", () => {
    const units = Array.from({ length: 12 }, (_, i) => unit([`c${i + 1}`]))
    const calls = packUnitsIntoCalls(units, 10)
    expect(calls.map((c) => c.length)).toEqual([10, 2])
  })

  it("keeps a unit straddling the budget boundary in ONE call", () => {
    // The acceptance criterion, and the entire behavioural difference from
    // today's `slice(i, i + 10)`: cells 10 and 11 are one sentence, so the call
    // ends early at 9 rather than cutting the sentence in half.
    const singles = Array.from({ length: 9 }, (_, i) => unit([`c${i + 1}`]))
    const straddling = unit(["c10", "c11"])
    const rest = Array.from({ length: 3 }, (_, i) => unit([`c${i + 12}`]))

    const calls = packUnitsIntoCalls([...singles, straddling, ...rest], 10)

    const callWith10 = calls.find((c) => c.includes("c10"))
    expect(callWith10).toContain("c11")
    expect(calls[0]).toHaveLength(9)
    expect(calls[0]).not.toContain("c10")
  })

  it("preserves document order and loses no cell", () => {
    const units = [unit(["a", "b"]), unit(["c"]), unit(["d", "e", "f"]), unit(["g"])]
    expect(packUnitsIntoCalls(units, 3).flat()).toEqual(["a", "b", "c", "d", "e", "f", "g"])
  })

  it("splits an oversize unit at its WEAKEST seam, not at a fixed stride", () => {
    // A 12-cell unit with an obvious dip at index 7 should break there. Breaking
    // at index 9 (the stride) would cut a tighter seam for no reason.
    const ids = Array.from({ length: 12 }, (_, i) => `c${i + 1}`)
    const strengths = ids.slice(1).map((_, i) => (i === 7 ? 0.51 : 0.95))
    const calls = packUnitsIntoCalls([unit(ids, strengths)], 10)
    expect(calls).toEqual([
      ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"],
      ["c9", "c10", "c11", "c12"],
    ])
  })

  it("keeps splitting until every piece fits the budget", () => {
    const ids = Array.from({ length: 25 }, (_, i) => `c${i + 1}`)
    const calls = packUnitsIntoCalls([unit(ids)], 10)
    expect(Math.max(...calls.map((c) => c.length))).toBeLessThanOrEqual(10)
    expect(calls.flat()).toHaveLength(25)
  })

  it("never merges two units into a call that exceeds the budget", () => {
    const calls = packUnitsIntoCalls([unit(["a", "b", "c"]), unit(["d", "e", "f"])], 4)
    expect(calls).toEqual([["a", "b", "c"], ["d", "e", "f"]])
  })

  it("emits a single-cell call rather than dropping a cell when budget is 1", () => {
    const calls = packUnitsIntoCalls([unit(["a", "b"])], 1)
    expect(calls).toEqual([["a"], ["b"]])
  })

  it("returns nothing for a non-positive budget instead of looping forever", () => {
    expect(packUnitsIntoCalls([unit(["a"])], 0)).toEqual([])
  })

  it("returns nothing for no units", () => {
    expect(packUnitsIntoCalls([], 10)).toEqual([])
  })
})
