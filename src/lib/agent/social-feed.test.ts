/**
 * social-feed tests — the transform that decides what the Team threads view
 * says. The contract (2026-08-28 social-workspace design): narrative event
 * kinds become persona-attributed messages in time order; plumbing kinds and
 * unknown future kinds are SKIPPED (never rendered as jargon); repeated
 * same-region phase updates collapse so a long run reads as a conversation,
 * not a log.
 */

import { describe, it, expect } from "vitest"
import type { ContextualActivityEvent } from "@/lib/contextual/transport"
import { buildRunFeed } from "./social-feed"

let counter = 0
function ev(overrides: Partial<ContextualActivityEvent> & { kind: string }): ContextualActivityEvent {
  counter += 1
  return {
    id: `e${String(counter).padStart(3, "0")}`,
    runId: "run-1",
    projectId: "p1",
    fileId: "f1",
    spanId: "s1",
    spanLabel: "MRK 4:1–4:8",
    summary: "",
    details: {},
    createdAt: `2026-08-28T12:00:${String(counter).padStart(2, "0")}Z`,
    ...overrides,
  }
}

describe("buildRunFeed", () => {
  it("narrates a span lifecycle with the right personas", () => {
    const feed = buildRunFeed({
      events: [
        ev({ kind: "span_started" }),
        ev({ kind: "phase", phase: "reading" }),
        ev({ kind: "scene_ready", details: { ambiguityCount: 2 } }),
        ev({ kind: "phase", phase: "drafting" }),
        ev({ kind: "phase", phase: "checking" }),
        ev({ kind: "drafts_staged", details: { count: 3 } }),
        ev({ kind: "span_outcome", status: "complete" }),
      ],
      sceneBriefs: [{ spanLabel: "MRK 4:1–4:8", l1Summary: "Jesus teaches by the lake." }],
    })
    expect(feed.map((m) => [m.persona, m.body.kind])).toEqual([
      ["coordinator", "started"],
      ["drafter", "phase"],
      ["drafter", "sceneReady"],
      ["drafter", "phase"],
      ["reviewer", "phase"],
      ["coordinator", "draftsStaged"],
      ["coordinator", "outcome"],
    ])
    const scene = feed[2].body
    if (scene.kind !== "sceneReady") throw new Error("expected sceneReady")
    expect(scene.ambiguityCount).toBe(2)
    expect(scene.excerpt).toBe("Jesus teaches by the lake.")
    const staged = feed[5].body
    if (staged.kind !== "draftsStaged") throw new Error("expected draftsStaged")
    expect(staged.count).toBe(3)
    // The receipt behind the sentence rides along for the step inspector.
    expect(feed[5].raw).toEqual({ kind: "drafts_staged", details: { count: 3 } })
    const outcome = feed[6].body
    if (outcome.kind !== "outcome") throw new Error("expected outcome")
    expect(outcome.status).toBe("done")
  })

  it("skips plumbing and unknown kinds instead of rendering jargon", () => {
    const feed = buildRunFeed({
      events: [
        ev({ kind: "run_created" }),
        ev({ kind: "run_state" }),
        ev({ kind: "llm" }),
        ev({ kind: "steering_queued" }),
        ev({ kind: "some_future_kind" }),
        // Staging phases would double up with drafts_staged / span_outcome.
        ev({ kind: "phase", phase: "staging" }),
      ],
      sceneBriefs: [],
    })
    expect(feed).toEqual([])
  })

  it("collapses consecutive same-region phase updates per span", () => {
    const feed = buildRunFeed({
      events: [
        ev({ kind: "phase", phase: "reading" }),
        ev({ kind: "phase", phase: "reading" }),
        // A different span's reading phase is its own conversation beat.
        ev({ kind: "phase", phase: "reading", spanId: "s2", spanLabel: "MRK 4:9–4:12" }),
        ev({ kind: "phase", phase: "drafting" }),
      ],
      sceneBriefs: [],
    })
    expect(feed).toHaveLength(3)
    expect(feed.map((m) => m.body.kind)).toEqual(["phase", "phase", "phase"])
  })

  it("reports failures and partial finishes with their reasons", () => {
    const failed = buildRunFeed({
      events: [ev({ kind: "span_outcome", status: "failed", details: { reasons: ["model refused"] } })],
      sceneBriefs: [],
    })
    const failedBody = failed[0].body
    if (failedBody.kind !== "outcome") throw new Error("expected outcome")
    expect(failedBody.status).toBe("failed")
    expect(failedBody.reasons).toEqual(["model refused"])

    const partial = buildRunFeed({
      events: [ev({ kind: "span_outcome", status: "complete", details: { skipped: 2 } })],
      sceneBriefs: [],
    })
    const partialBody = partial[0].body
    if (partialBody.kind !== "outcome") throw new Error("expected outcome")
    expect(partialBody.status).toBe("partial")
  })

  it("orders messages by event time even when the input is shuffled", () => {
    const started = ev({ kind: "span_started" })
    const outcome = ev({ kind: "span_outcome", status: "complete" })
    const feed = buildRunFeed({ events: [outcome, started], sceneBriefs: [] })
    expect(feed.map((m) => m.body.kind)).toEqual(["started", "outcome"])
  })
})
