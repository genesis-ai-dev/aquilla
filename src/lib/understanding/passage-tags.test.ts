// Unit tests for the tag combine rule and its heuristics (AQU-657, slice 1).
//
// The load-bearing properties: a tag is decided PER TAG (a confident speech
// answer survives an undecided cast), an answer under the confidence gate falls
// back to the heuristic rather than voting, and a node's cache key changes when
// either its text or the cast it was asked about changes.

import { describe, expect, it } from "vitest"
import {
  DEFAULT_TAG_THRESHOLDS,
  EMPTY_CANDIDATES,
  combinePassageTags,
  heuristicParticipants,
  heuristicSceneChange,
  heuristicSpeech,
  isPassageTags,
  lexicalOverlap,
  passageTagKey,
  shortlistRelated,
  taggedParticipants,
  taggedReferences,
  type PassageTagNode,
  type TagCandidates,
} from "./passage-tags"

function node(overrides: Partial<PassageTagNode> = {}): PassageTagNode {
  return {
    key: "passage:LUK 5:27",
    label: "LUK 5:27–32",
    text: "After these things he went out, and saw a tax collector named Levi.",
    startRef: "LUK 5:27",
    endRef: "LUK 5:32",
    ...overrides,
  }
}

const CAST = ["Jesus", "Levi", "Mary"]

function candidates(overrides: Partial<TagCandidates> = {}): TagCandidates {
  return { participants: CAST, related: [], ...overrides }
}

describe("heuristicParticipants", () => {
  it("matches a name on letter boundaries, not inside a longer word", () => {
    expect(heuristicParticipants("Mary said nothing.", ["Mary"])).toEqual(["Mary"])
    expect(heuristicParticipants("Rosemary said nothing.", ["Mary"])).toEqual([])
    expect(heuristicParticipants("Marys of Galilee", ["Mary"])).toEqual([])
  })

  it("matches a name wrapped in punctuation or quotation marks", () => {
    expect(heuristicParticipants("«Levi», he called.", ["Levi"])).toEqual(["Levi"])
  })

  it("ignores case and empty candidates", () => {
    expect(heuristicParticipants("LEVI rose up.", ["Levi", "  "])).toEqual(["Levi"])
  })
})

describe("heuristicSpeech", () => {
  it("is true when most of the passage sits inside quotation marks", () => {
    expect(heuristicSpeech("“Why do you reason so in your hearts, every one of you?” he said."))
      .toBe(true)
  })

  it("is false for narration carrying one quoted line", () => {
    expect(heuristicSpeech(
      "He went down to the lake and stood a long while watching the fishermen "
      + "wash their nets in the shallow water, and then he said, “Come.”",
    )).toBe(false)
  })

  it("treats an unclosed quotation as running to the end of the passage", () => {
    expect(heuristicSpeech("He said, “Arise and walk, take up your cot and go home"))
      .toBe(true)
  })

  it("is false for empty text", () => {
    expect(heuristicSpeech("")).toBe(false)
  })
})

describe("heuristicSceneChange", () => {
  it("is true when the passage opens in a different chapter", () => {
    expect(heuristicSceneChange({ startRef: "LUK 6:1" }, { endRef: "LUK 5:39" })).toBe(true)
  })

  it("is false within one chapter", () => {
    expect(heuristicSceneChange({ startRef: "LUK 5:27" }, { endRef: "LUK 5:26" })).toBe(false)
  })

  it("is false — not unknown-as-true — when there are no refs to compare", () => {
    expect(heuristicSceneChange({ startRef: null }, { endRef: "LUK 5:26" })).toBe(false)
    expect(heuristicSceneChange({ startRef: "LUK 5:27" }, null)).toBe(false)
  })
})

describe("lexicalOverlap and shortlistRelated", () => {
  it("ignores tokens too short to carry evidence", () => {
    // Nothing but short function words in common → no overlap at all.
    expect(lexicalOverlap("he was in the boat", "she is on the hill")).toBe(0)
  })

  it("ranks candidates by overlap, strongest first, excluding the node itself", () => {
    const self = node({ key: "a", text: "Levi made a great feast for him in his house." })
    const others: PassageTagNode[] = [
      self,
      node({ key: "b", text: "The feast in Levi's house ran late into the evening." }),
      node({ key: "c", text: "Snow closed the mountain road for a week." }),
    ]
    expect(shortlistRelated(self, others).map((c) => c.key)).toEqual(["b"])
  })

  it("returns nothing when asked for nothing", () => {
    expect(shortlistRelated(node(), [node({ key: "b" })], 0)).toEqual([])
  })
})

describe("passageTagKey", () => {
  it("changes when a covered source event changes", () => {
    const before = passageTagKey("passage:1", ["e1", "e2"], candidates())
    const after = passageTagKey("passage:1", ["e1", "e3"], candidates())
    expect(before).not.toBeNull()
    expect(after).not.toEqual(before)
  })

  it("changes when the cast the node was asked about grows", () => {
    const before = passageTagKey("passage:1", ["e1"], candidates())
    const after = passageTagKey("passage:1", ["e1"], candidates({
      participants: [...CAST, "Simon"],
    }))
    expect(after).not.toEqual(before)
  })

  it("changes when the candidate reference set changes", () => {
    const before = passageTagKey("passage:1", ["e1"], candidates())
    const after = passageTagKey("passage:1", ["e1"], candidates({
      related: [{ key: "passage:2", label: "2", text: "text" }],
    }))
    expect(after).not.toEqual(before)
  })

  it("is null when any covered cell has no source event yet", () => {
    expect(passageTagKey("passage:1", ["e1", null], candidates())).toBeNull()
    expect(passageTagKey("passage:1", [], candidates())).toBeNull()
  })

  it("is stable across calls for the same content", () => {
    expect(passageTagKey("passage:1", ["e1", "e2"], candidates()))
      .toEqual(passageTagKey("passage:1", ["e1", "e2"], candidates()))
  })
})

describe("combinePassageTags", () => {
  it("falls back to the heuristic for every tag when there are no answers", () => {
    const tags = combinePassageTags(node(), null, candidates(), null)
    expect(taggedParticipants(tags)).toEqual(["Levi"])
    expect(tags.participants.every((p) => p.decidedBy === "heuristic")).toBe(true)
    expect(tags.sceneChange.decidedBy).toBe("heuristic")
    expect(tags.speech).toMatchObject({ value: false, decidedBy: "heuristic" })
  })

  it("takes a confident model answer over the heuristic, including against it", () => {
    // The hard case from the fixture: the passage's only participant marker is a
    // pronoun, so the name heuristic says absent and the model says present.
    const tags = combinePassageTags(
      node({ text: "He said to them, “Can you make the friends of the bridegroom fast?”" }),
      node({ key: "passage:prev", endRef: "LUK 5:32" }),
      candidates(),
      { participants: [0.95, 0.03, 0.02], speech: 0.9, scene_change: 0.08 },
    )
    expect(taggedParticipants(tags)).toEqual(["Jesus"])
    expect(tags.participants[0]).toMatchObject({ decidedBy: "model", value: true })
    expect(tags.speech).toMatchObject({ value: true, decidedBy: "model" })
    expect(tags.sceneChange).toMatchObject({ value: false, decidedBy: "model" })
  })

  it("discards an answer under the confidence gate and keeps the confident ones", () => {
    const tags = combinePassageTags(
      node(),
      null,
      candidates(),
      // 0.55 is 0.1 certainty — under the 0.4 gate. 0.95 is well over it.
      { participants: [0.55, 0.95, 0.5], speech: 0.52 },
    )
    expect(tags.participants[0].decidedBy).toBe("heuristic")
    expect(tags.participants[1]).toMatchObject({ decidedBy: "model", value: true })
    expect(tags.speech.decidedBy).toBe("heuristic")
  })

  it("reports a heuristic decision as fully confident with a 1/0 probability", () => {
    const tags = combinePassageTags(node(), null, candidates(), null)
    const levi = tags.participants.find((p) => p.name === "Levi")
    expect(levi).toMatchObject({ probability: 1, confidence: 1 })
    expect(tags.participants.find((p) => p.name === "Mary"))
      .toMatchObject({ probability: 0, confidence: 1 })
  })

  it("ignores an out-of-range probability rather than trusting it", () => {
    const tags = combinePassageTags(node(), null, candidates(), {
      participants: [1.4, Number.NaN, undefined],
    })
    expect(tags.participants.every((p) => p.decidedBy === "heuristic")).toBe(true)
  })

  it("orders asserted references by probability", () => {
    const related = [
      { key: "passage:weak", label: "weak", text: "unrelated" },
      { key: "passage:strong", label: "strong", text: "unrelated" },
    ]
    const tags = combinePassageTags(node(), null, candidates({ related }), {
      related: [0.75, 0.98],
    })
    expect(taggedReferences(tags)).toEqual(["passage:strong", "passage:weak"])
  })

  it("asks nothing and asserts nothing when there are no candidates", () => {
    const tags = combinePassageTags(node(), null, EMPTY_CANDIDATES, null)
    expect(tags.participants).toEqual([])
    expect(tags.refersTo).toEqual([])
  })

  it("honours a caller's thresholds", () => {
    const strict = combinePassageTags(node(), null, candidates(), { speech: 0.8 }, {
      ...DEFAULT_TAG_THRESHOLDS,
      confidence: 0.9,
    })
    expect(strict.speech.decidedBy).toBe("heuristic")
  })

  it("produces a value the shared contract guard accepts", () => {
    expect(isPassageTags(combinePassageTags(node(), null, candidates(), null))).toBe(true)
    expect(isPassageTags({ nodeKey: "x", participants: [], refersTo: [] })).toBe(false)
    expect(isPassageTags(null)).toBe(false)
  })
})
