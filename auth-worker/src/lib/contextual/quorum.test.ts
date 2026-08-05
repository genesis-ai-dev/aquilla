import { describe, expect, it } from "vitest"
import { tallyVotes } from "./quorum"
import type { CellVerdict, SpanDraft, Vote, VerifierKey } from "./types"

const draft: SpanDraft = {
  spanId: "span1",
  sceneBriefId: "sb1",
  cells: [
    { cellId: "c1", text: "t1" },
    { cellId: "c2", text: "t2" },
  ],
  exampleIds: [],
  promptVersion: "contextual-draft-v2:deadbeef",
}

function vote(verifier: VerifierKey, approve: boolean, cellVerdicts: CellVerdict[] = [], reason = ""): Vote {
  return { spanId: "span1", verifier, approve, cellVerdicts, reason }
}

describe("tallyVotes", () => {
  it("accepts a cell on 2-of-3 approvals", () => {
    const votes = [
      vote("force", true),
      vote("ambiguity", true),
      vote("naturalness", false, [
        { cellId: "c1", approve: false, reason: "calque" },
        { cellId: "c2", approve: true },
      ]),
    ]
    const result = tallyVotes(votes, draft)
    expect(result.accepted).toEqual(["c1", "c2"])
  })

  it("rejects a cell when two of three disapprove", () => {
    const votes = [
      vote("force", false, [{ cellId: "c1", approve: false, reason: "command softened" }]),
      vote("ambiguity", true),
      vote("naturalness", false, [{ cellId: "c1", approve: false, reason: "unidiomatic" }]),
    ]
    const result = tallyVotes(votes, draft)
    expect(result.accepted).toEqual([])
    const c1 = result.rejected.find((r) => r.cellId === "c1")
    expect(c1?.constraints).toEqual(["force: command softened", "naturalness: unidiomatic"])
    // c2 inherits both span-level disapprovals (no explicit verdicts).
    expect(result.rejected.map((r) => r.cellId).sort()).toEqual(["c1", "c2"])
  })

  it("verify_ambiguity carries an absolute veto over a 2-of-3 majority", () => {
    const votes = [
      vote("force", true),
      vote("ambiguity", true, [
        { cellId: "c1", approve: false, reason: "resolves register entry span1:amb:1" },
        { cellId: "c2", approve: true },
      ]),
      vote("naturalness", true),
    ]
    const result = tallyVotes(votes, draft)
    expect(result.accepted).toEqual(["c2"])
    expect(result.rejected).toEqual([
      { cellId: "c1", constraints: ["ambiguity: resolves register entry span1:amb:1"] },
    ])
  })

  it("a lone ambiguity vote decides a low-risk span by itself", () => {
    const approveAll = tallyVotes([vote("ambiguity", true)], draft)
    expect(approveAll.accepted).toEqual(["c1", "c2"])

    const rejectOne = tallyVotes(
      [vote("ambiguity", true, [{ cellId: "c2", approve: false, reason: "over-clarified" }])],
      draft,
    )
    expect(rejectOne.accepted).toEqual(["c1"])
    expect(rejectOne.rejected).toEqual([{ cellId: "c2", constraints: ["ambiguity: over-clarified"] }])
  })

  it("per-cell verdicts override the vote's span-level approve", () => {
    const votes = [
      vote("force", true, [{ cellId: "c1", approve: false, reason: "plea hardened" }]),
      vote("naturalness", true),
      vote("ambiguity", true),
    ]
    const result = tallyVotes(votes, draft)
    // c1: 2 approvals of 3 → still accepted (no veto); the override changed the count.
    expect(result.accepted).toEqual(["c1", "c2"])
  })

  it("a 1-of-2 tie is a rejection (strict majority required)", () => {
    const votes = [vote("ambiguity", true), vote("naturalness", false, [], "flat wording")]
    const result = tallyVotes(votes, draft)
    expect(result.accepted).toEqual([])
    expect(result.rejected).toHaveLength(2)
  })
})
