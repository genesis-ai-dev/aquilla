import { describe, expect, it } from "vitest"
import { extractEdits } from "./extract"
import { settledPairs, SETTLE_WINDOW_MS, type ChainEvent } from "./chains"
import { observationsFromPair } from "./observe"
import {
  findCandidates,
  keepKey,
  scoreCandidates,
  selectForDisplay,
  type Observation,
  type ScoreInputs,
} from "./suggest"

const NO_EVIDENCE: ScoreInputs = { keeps: new Map(), reverted: new Set(), dismissals: new Map() }

function obs(cell: string, before: string, after: string, source: string, ts = 1): Observation[] {
  return observationsFromPair(
    { afterId: `e-${cell}-${ts}`, beforeId: "p", author: "a", ts, before, after, beforeOrigin: "human", bulkKey: null },
    cell,
    source,
  )
}

describe("extractEdits", () => {
  it("records a multi-word replacement as one phrase, not word-by-word pairs (old ICE bug)", () => {
    const { ops } = extractEdits("and the Lord said to Moses", "and Yahweh said to Moses")
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({ old: "the Lord", new: "Yahweh", left: ["and"], right: ["said", "to"] })
  })

  it("skips retranslations — a rewritten sentence is not a reusable pattern", () => {
    expect(extractEdits("the cat sat on the mat", "a dog ran across a field").skipped).toBe("rewrite")
  })

  it("keeps surface casing but compares case-insensitively", () => {
    expect(extractEdits("The Lord is good", "the Lord is good").skipped).toBe("identical")
  })
})

describe("settledPairs", () => {
  const ev = (id: string, parentId: string | null, ts: number, value: string, origin: ChainEvent["origin"] = "human"): ChainEvent => ({
    id, parentId, author: "u", ts, value, origin, bulkKey: null,
  })

  it("collapses a burst of idle-commits into one edit so half-typed words never count", () => {
    const events = [
      ev("a", null, 0, "the Lord said"),
      ev("b", "a", SETTLE_WINDOW_MS + 1, "the Yah said"),
      ev("c", "b", SETTLE_WINDOW_MS + 2, "the Yahweh said"),
    ]
    const pairs = settledPairs(events, 10 * SETTLE_WINDOW_MS)
    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toMatchObject({ before: "the Lord said", after: "the Yahweh said" })
  })

  it("learns from AI draft → human correction even when the human edits seconds later", () => {
    const events = [ev("d", null, 0, "the Lord said", "ai"), ev("h", "d", 5, "Yahweh said")]
    const pairs = settledPairs(events, 10 * SETTLE_WINDOW_MS)
    expect(pairs).toEqual([expect.objectContaining({ beforeOrigin: "ai", after: "Yahweh said" })])
  })

  it("never treats an agent or AI commit as human expertise on the after side", () => {
    const events = [ev("a", null, 0, "x y"), ev("b", "a", SETTLE_WINDOW_MS * 2, "x z", "machine")]
    expect(settledPairs(events, SETTLE_WINDOW_MS * 5)).toEqual([])
  })

  it("waits until a human commit is settled before learning from it", () => {
    const events = [ev("a", null, 0, "x y"), ev("b", "a", SETTLE_WINDOW_MS * 2, "x z")]
    expect(settledPairs(events, SETTLE_WINDOW_MS * 2 + 1000)).toEqual([])
  })
})

describe("suggestions", () => {
  it("suggests an edit the team made in other cells with the same source anchor", () => {
    const memory = [
      ...obs("c1", "and the Lord spoke", "and Yahweh spoke", "וַיְדַבֵּר יְהוָה"),
      ...obs("c2", "for the Lord is good", "for Yahweh is good", "כִּי טוֹב יְהוָה"),
    ]
    const cells = [{ id: "c3", source: "יְהוָה רֹעִי", target: "the Lord is my shepherd" }]
    const scored = scoreCandidates(findCandidates(cells, memory), NO_EVIDENCE)
    const best = scored.find((s) => s.oldNorm === "the lord")
    expect(best).toMatchObject({ new: "Yahweh", tier: "show" })
    expect(best?.examples.length).toBeGreaterThan(0)
  })

  it("does not carry a divine-name edit onto a cell whose source has a different word (context splits patterns)", () => {
    const memory = [
      ...obs("c1", "and the Lord spoke", "and Yahweh spoke", "וַיְדַבֵּר יְהוָה"),
      ...obs("c2", "for the Lord is good", "for Yahweh is good", "כִּי טוֹב יְהוָה"),
    ]
    const cells = [{ id: "c3", source: "אֲדֹנָי שְׁמָעָה", target: "O the Lord hear" }]
    const [s] = scoreCandidates(findCandidates(cells, memory), NO_EVIDENCE)
    expect(s.tier).not.toBe("show")
  })

  it("lets kept occurrences outvote a one-off edit", () => {
    const memory = [
      ...obs("c1", "and the Lord spoke", "and Yahweh spoke", "יְהוָה x"),
      ...obs("c2", "for the Lord is good", "for Yahweh is good", "יְהוָה y"),
    ]
    const cells = [{ id: "c3", source: "יְהוָה z", target: "the Lord is my shepherd" }]
    const candidates = findCandidates(cells, memory)
    const anchors = candidates[0].replacements[0].anchors
    const keeps = new Map([[keepKey("the lord", anchors), 40]])
    const [s] = scoreCandidates(candidates, { ...NO_EVIDENCE, keeps })
    expect(s.tier).not.toBe("show")
  })

  it("never suggests a cell's own past edit back onto it", () => {
    const memory = obs("c1", "the Lord spoke", "Yahweh spoke", "יְהוָה")
    const cells = [{ id: "c1", source: "יְהוָה", target: "the Lord spoke" }]
    expect(findCandidates(cells, memory)).toEqual([])
  })

  it("matches the occurrence's capitalisation", () => {
    const memory = [...obs("c1", "and the lord spoke", "and yahweh spoke", "x"), ...obs("c2", "for the lord is", "for yahweh is", "x")]
    const [s] = scoreCandidates(findCandidates([{ id: "c3", source: "x", target: "The lord rules" }], memory), NO_EVIDENCE)
    expect(s.new).toBe("Yahweh")
  })

  it("shows at most two non-overlapping underlines per cell", () => {
    const memory = ["a", "b", "c"].flatMap((w, i) => [
      ...obs(`m${i}a`, `x ${w} y`, `x ${w}${w} y`, "s"),
      ...obs(`m${i}b`, `x ${w} y`, `x ${w}${w} y`, "s"),
    ])
    const scored = scoreCandidates(findCandidates([{ id: "t", source: "s", target: "x a y x b y x c y" }], memory), NO_EVIDENCE)
    expect(selectForDisplay(scored)).toHaveLength(2)
  })
})
