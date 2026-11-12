// react-route — what the react loop does with Jev's answers
// (docs/superpowers/specs/2026-09-30-jev-react-decisions-design.md §2).
// The point of the whole feature is in these rows: a typo must not cost a
// drafting run, an unclear edit must be asked about rather than acted on, and a
// project's scope must never be widened by a model's opinion.

import { describe, expect, it } from "vitest"
import type { JevAnswer } from "./jev/decide"
import {
  askQuestionText,
  fallbackReactAnswers,
  routeReaction,
  type EditSample,
} from "./react-route"

const p = (v: number): JevAnswer => ({ kind: "noul", p: v })

function answers(o: Partial<Record<"substantive" | "unclear_intent" | "want_redraft" | "want_check" | "want_learn", number>>) {
  return {
    substantive: p(o.substantive ?? 0.9),
    unclear_intent: p(o.unclear_intent ?? 0.1),
    want_redraft: p(o.want_redraft ?? 0),
    want_check: p(o.want_check ?? 0),
    want_learn: p(o.want_learn ?? 0),
  }
}

describe("routeReaction", () => {
  it("skips an edit Jev judges not substantive — no run for a typo", () => {
    expect(routeReaction(answers({ substantive: 0.2, want_redraft: 0.9 }), "full").action).toBe("skip")
  })

  it("asks when intent is unclear, before any action is considered", () => {
    expect(routeReaction(answers({ unclear_intent: 0.7, want_redraft: 0.95 }), "full").action).toBe("ask")
  })

  it.each([
    [{ want_redraft: 0.8, want_check: 0.6 }, "redraft"],
    [{ want_check: 0.7, want_redraft: 0.4 }, "check"],
    [{ want_learn: 0.9, want_redraft: 0.6 }, "learn"],
  ])("takes the strongest action at or above 0.5 (%o → %s)", (o, action) => {
    expect(routeReaction(answers(o), "full").action).toBe(action)
  })

  it("defaults to the cheapest safe action when nothing is clear", () => {
    expect(routeReaction(answers({ want_redraft: 0.3, want_check: 0.2 }), "full").action).toBe("check")
  })

  it("never redrafts under a checks-only scope, whatever Jev prefers", () => {
    expect(routeReaction(answers({ want_redraft: 0.95, want_check: 0.55 }), "qa").action).toBe("check")
    expect(routeReaction(answers({ want_redraft: 0.95 }), "qa").action).toBe("check")
  })

  it("never runs a check-only reaction under a drafts-only scope", () => {
    expect(routeReaction(answers({ want_check: 0.95 }), "draft").action).toBe("redraft")
  })

  it("lets learn through any scope — it only proposes, pending approval", () => {
    expect(routeReaction(answers({ want_learn: 0.8 }), "qa").action).toBe("learn")
  })
})

describe("fallbackReactAnswers (Jev unavailable)", () => {
  const sample = (before: string, after: string): EditSample => ({ ref: "GEN 1:1", source: "src", before, after })

  it("treats a spacing, punctuation, or case-only change as not substantive", () => {
    const out = routeReaction(fallbackReactAnswers([sample("In the beginning", "In the beginning, ")]), "full")
    expect(out.action).toBe("skip")
  })

  it("reproduces today's behaviour for a real change: redraft, or check under qa", () => {
    const edits = [sample("In the beginning", "At the start")]
    expect(routeReaction(fallbackReactAnswers(edits), "full").action).toBe("redraft")
    expect(routeReaction(fallbackReactAnswers(edits), "qa").action).toBe("check")
  })

  it("reacts as before when it cannot read the edit text (unknown is not 'typo')", () => {
    expect(routeReaction(fallbackReactAnswers([]), "full").action).toBe("redraft")
    expect(routeReaction(fallbackReactAnswers([sample("", "")]), "full").action).toBe("redraft")
  })

  it("counts a validation (no text change) as substantive expert input", () => {
    expect(routeReaction(fallbackReactAnswers([sample("Same", "Same")], { validationOnly: true }), "full").action)
      .toBe("redraft")
  })
})

describe("askQuestionText", () => {
  it("quotes the change so the expert can answer without opening the file", () => {
    const text = askQuestionText([{ ref: "GEN 1:3", source: "s", before: "light", after: "brightness" }], 1)
    expect(text).toContain("GEN 1:3")
    expect(text).toContain("“light”")
    expect(text).toContain("“brightness”")
  })

  it("stays under the decision reason limit on long cells", () => {
    const long = "x".repeat(5000)
    expect(new TextEncoder().encode(askQuestionText([{ ref: "A", source: "", before: long, after: long }], 1)).length)
      .toBeLessThan(1000)
  })
})
