import { describe, expect, it } from "vitest"
import { runReviewOf } from "./useRunReview"
import type { ContextualDraftRecord } from "@/lib/contextual/transport"

const draft = (cellId: string, spanLabel: string, triage: "human" | "advisory" | null): ContextualDraftRecord => ({
  draftId: `d-${cellId}`, runId: "r", cellId, text: "t", spanLabel,
  review: {
    findings: triage ? [{ code: "unsupported", kind: "unsupported", detail: null }] : [],
    triage, severity: triage ? 3 : 0,
  },
})

describe("runReviewOf", () => {
  // Only passages with a "needs you" draft stay expanded in the timeline; an
  // advisory note alone must not keep a clean passage open.
  it("counts findings and names the passages a person must look at", () => {
    const out = runReviewOf([draft("a", "P1", "human"), draft("b", "P2", "advisory"), draft("c", "P2", null)])
    expect(out).toMatchObject({ pending: 3, flagged: 2, needsHuman: 1 })
    expect([...out.needsHumanSpans]).toEqual(["P1"])
  })
})
