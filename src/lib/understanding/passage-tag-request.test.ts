// Wire-format tests for passage tags (AQU-657, slice 1).
//
// This is the upstream contract, so the properties tested are the ones a change
// here would silently break: every question carries the labels the state defines,
// candidate texts are sent once, the first node of a window is not asked a
// question about a predecessor it cannot see, an oversize window throws instead
// of truncating, and a partial or malformed response degrades one node rather
// than the window.

import { describe, expect, it } from "vitest"
import {
  JEV_MODEL,
  MAX_NODES_PER_REQUEST,
  buildPassageTagRequest,
  nodeQuestionId,
  tagWindows,
  participantQuestionId,
  parsePassageTagAnswers,
  relatedQuestionId,
  type TaggedNodeRequest,
} from "./passage-tag-request"
import type { PassageTagNode } from "./passage-tags"

function node(key: string, text = `text for ${key}`): PassageTagNode {
  return { key, label: key, text, startRef: null, endRef: null }
}

function request(
  key: string,
  participants: string[] = [],
  related: { key: string; label: string; text: string }[] = [],
): TaggedNodeRequest {
  return { node: node(key), candidates: { participants, related } }
}

function noul(value: number): { type: "noul"; noul: number } {
  return { type: "noul", noul: value }
}

describe("buildPassageTagRequest", () => {
  it("pins the model and puts every node in state, in window order", () => {
    const built = buildPassageTagRequest([request("a"), request("b")])
    expect(built.model).toBe(JEV_MODEL)
    expect(built.state.passages.map((p) => p.index)).toEqual([0, 1])
    expect(built.state.passages[1].text).toBe("text for b")
  })

  it("does not ask the first node about a scene change it cannot see", () => {
    const built = buildPassageTagRequest([request("a"), request("b")])
    expect(built.questions[nodeQuestionId(0, "scene_change")]).toBeUndefined()
    expect(built.questions[nodeQuestionId(1, "scene_change")]).toBeDefined()
    expect(built.questions[nodeQuestionId(1, "scene_change")].instructions)
      .toMatchObject({ this_passage: "passage 1", previous_passage: "passage 0" })
  })

  it("asks speech of every node, first one included", () => {
    const built = buildPassageTagRequest([request("a"), request("b")])
    expect(built.questions[nodeQuestionId(0, "speech")]).toBeDefined()
    expect(built.questions[nodeQuestionId(1, "speech")]).toBeDefined()
  })

  it("asks one question per participant candidate, naming the participant", () => {
    const built = buildPassageTagRequest([request("a", ["Jesus", "Levi"])])
    expect(built.questions[participantQuestionId(0, 0)].instructions)
      .toMatchObject({ participant: "Jesus", this_passage: "passage 0" })
    expect(built.questions[participantQuestionId(0, 1)].instructions)
      .toMatchObject({ participant: "Levi" })
    expect(built.questions[participantQuestionId(0, 2)]).toBeUndefined()
  })

  it("sends a candidate passage's text once however many nodes name it", () => {
    const shared = { key: "passage:shared", label: "shared", text: "the shared passage" }
    const built = buildPassageTagRequest([
      request("a", [], [shared]),
      request("b", [], [shared]),
    ])
    expect(built.state.candidates).toEqual([{ label: "shared", text: "the shared passage" }])
    // Both nodes point at the SAME candidate label in state.
    expect(built.questions[relatedQuestionId(0, 0)].instructions)
      .toMatchObject({ candidate_passage: "candidate 0" })
    expect(built.questions[relatedQuestionId(1, 0)].instructions)
      .toMatchObject({ candidate_passage: "candidate 0" })
  })

  it("carries the ref range into state when the node has refs", () => {
    const withRefs: TaggedNodeRequest = {
      node: { ...node("a"), startRef: "LUK 5:1", endRef: "LUK 5:11" },
      candidates: { participants: [], related: [] },
    }
    expect(buildPassageTagRequest([withRefs]).state.passages[0].range).toBe("LUK 5:1–LUK 5:11")
  })

  it("throws on an oversize window rather than silently truncating it", () => {
    const window = Array.from({ length: MAX_NODES_PER_REQUEST + 1 }, (_, i) => request(`n${i}`))
    expect(() => buildPassageTagRequest(window)).toThrow(/MAX_NODES_PER_REQUEST/)
  })
})

describe("parsePassageTagAnswers", () => {
  it("demuxes answers back onto the nodes and candidates that asked them", () => {
    const window = [
      request("a", ["Jesus", "Levi"], [{ key: "r1", label: "r1", text: "r1" }]),
      request("b", ["Jesus", "Levi"]),
    ]
    const parsed = parsePassageTagAnswers({
      answers: {
        [nodeQuestionId(0, "speech")]: noul(0.9),
        [participantQuestionId(0, 0)]: noul(0.95),
        [participantQuestionId(0, 1)]: noul(0.05),
        [relatedQuestionId(0, 0)]: noul(0.8),
        [nodeQuestionId(1, "scene_change")]: noul(0.7),
      },
    }, window)

    expect(parsed[0]).toEqual({
      speech: 0.9,
      participants: [0.95, 0.05],
      related: [0.8],
    })
    expect(parsed[1]).toEqual({ scene_change: 0.7 })
  })

  it("leaves a candidate unanswered rather than defaulting it", () => {
    const window = [request("a", ["Jesus", "Levi"])]
    const parsed = parsePassageTagAnswers({
      answers: { [participantQuestionId(0, 1)]: noul(0.9) },
    }, window)
    expect(parsed[0]?.participants).toEqual([undefined, 0.9])
  })

  it("returns null for a node with no usable answers, not an empty object", () => {
    const window = [request("a", ["Jesus"]), request("b", ["Jesus"])]
    const parsed = parsePassageTagAnswers({
      answers: { [participantQuestionId(0, 0)]: noul(0.9) },
    }, window)
    expect(parsed[0]).not.toBeNull()
    expect(parsed[1]).toBeNull()
  })

  it("survives a malformed body, a missing answers map, and non-numeric answers", () => {
    const window = [request("a", ["Jesus"])]
    expect(parsePassageTagAnswers(null, window)).toEqual([null])
    expect(parsePassageTagAnswers({}, window)).toEqual([null])
    expect(parsePassageTagAnswers({ answers: "nope" }, window)).toEqual([null])
    expect(parsePassageTagAnswers({
      answers: { [participantQuestionId(0, 0)]: { type: "noul", noul: "yes" } },
    }, window)).toEqual([null])
  })

  it("round-trips the ids the builder emitted", () => {
    const window = [request("a", ["Jesus"], [{ key: "r1", label: "r1", text: "r1" }])]
    const built = buildPassageTagRequest(window)
    const answers = Object.fromEntries(
      Object.keys(built.questions).map((id) => [id, noul(0.99)]),
    )
    const parsed = parsePassageTagAnswers({ answers }, window)
    expect(parsed[0]).toEqual({ speech: 0.99, participants: [0.99], related: [0.99] })
  })
})

describe("tagWindows", () => {
  it("covers every node exactly once past the one-node overlap", () => {
    const count = MAX_NODES_PER_REQUEST * 2 + 3
    const windows = tagWindows(count)
    expect(windows[0]).toEqual({ from: 0, to: MAX_NODES_PER_REQUEST })
    const covered = new Set<number>()
    for (const { from, to } of windows) {
      for (let i = from; i < to; i += 1) covered.add(i)
    }
    expect(covered.size).toBe(count)
  })

  it("reopens each window on the previous window's last node — exactly one", () => {
    const windows = tagWindows(MAX_NODES_PER_REQUEST + 3)
    expect(windows).toHaveLength(2)
    expect(windows[1].from).toBe(windows[0].to - 1)
  })

  it("never exceeds MAX_NODES_PER_REQUEST, so the builder cannot throw on its own windows", () => {
    for (const count of [1, 2, MAX_NODES_PER_REQUEST, MAX_NODES_PER_REQUEST + 1, 97]) {
      for (const { from, to } of tagWindows(count)) {
        expect(to - from).toBeLessThanOrEqual(MAX_NODES_PER_REQUEST)
        expect(to).toBeGreaterThan(from)
      }
    }
  })

  it("has nothing to ask about an empty spine", () => {
    expect(tagWindows(0)).toEqual([])
  })
})
