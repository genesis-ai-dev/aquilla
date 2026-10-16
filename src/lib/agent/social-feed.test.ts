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
import { buildRunFeed, groupFeedByPassage, groupRunFeed, type TeamFeedMessage } from "./social-feed"

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
    // The receipt behind the sentence rides along for the step inspector,
    // with the run/span ids it needs to look up outputs and model calls.
    expect(feed[5].raw).toMatchObject({
      kind: "drafts_staged",
      details: { count: 3 },
      runId: "run-1",
      spanId: "s1",
      spanLabel: "MRK 4:1–4:8",
    })
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

  // Colliding wire ids were seen live (2026-08-28 review: five identical ids
  // in one run's activity). The seed that minted them is fixed, but the feed
  // must stay correct regardless: message ids key React's list AND address the
  // step inspector's selection, so a collision silently swallows a step.
  it("collapses a re-delivered event (same id AND same kind) to one message", () => {
    const feed = buildRunFeed({
      events: [
        ev({ kind: "span_started", id: "dup", createdAt: "2026-08-28T12:00:01Z" }),
        ev({ kind: "span_started", id: "dup", createdAt: "2026-08-28T12:00:02Z" }),
        ev({ kind: "drafts_staged", id: "other", details: { count: 1 } }),
      ],
      sceneBriefs: [],
    })
    expect(feed.map((m) => m.body.kind)).toEqual(["started", "draftsStaged"])
    expect(feed.map((m) => m.id)).toEqual(["dup", "other"])
  })

  it("keeps both steps when one id carries two different kinds, under distinct ids", () => {
    const feed = buildRunFeed({
      events: [
        ev({ kind: "span_started", id: "dup", createdAt: "2026-08-28T12:00:01Z" }),
        ev({ kind: "scene_ready", id: "dup", createdAt: "2026-08-28T12:00:02Z" }),
        ev({ kind: "drafts_staged", id: "dup", createdAt: "2026-08-28T12:00:03Z" }),
      ],
      sceneBriefs: [],
    })
    expect(feed.map((m) => m.body.kind)).toEqual(["started", "sceneReady", "draftsStaged"])
    // Deterministic suffixes, so a re-fetch of the same activity addresses the
    // same step: the inspector's selection survives a poll.
    expect(feed.map((m) => m.id)).toEqual(["dup", "dup#2", "dup#3"])
    expect(new Set(feed.map((m) => m.id)).size).toBe(feed.length)
  })

  it("lets a re-delivered phase event leave no trace on the collapse state", () => {
    // The duplicate must be dropped BEFORE the phase bookkeeping: if it
    // advanced the collapse cursor, the genuine "checking" beat behind it
    // would be swallowed as a repeat.
    const feed = buildRunFeed({
      events: [
        ev({ kind: "phase", phase: "reading", id: "p1", createdAt: "2026-08-28T12:00:01Z" }),
        ev({ kind: "phase", phase: "checking", id: "p1", createdAt: "2026-08-28T12:00:02Z" }),
        ev({ kind: "phase", phase: "checking", id: "p2", createdAt: "2026-08-28T12:00:03Z" }),
      ],
      sceneBriefs: [],
    })
    // p1's second delivery is the same (id, kind) as its first, so it drops;
    // p2 is the run's first surviving "checking" beat and must survive.
    expect(feed.map((m) => m.id)).toEqual(["p1", "p2"])
    expect(feed.map((m) => m.persona)).toEqual(["drafter", "reviewer"])
  })

  it("orders messages by event time even when the input is shuffled", () => {
    const started = ev({ kind: "span_started" })
    const outcome = ev({ kind: "span_outcome", status: "complete" })
    const feed = buildRunFeed({ events: [outcome, started], sceneBriefs: [] })
    expect(feed.map((m) => m.body.kind)).toEqual(["started", "outcome"])
  })
})

describe("groupRunFeed", () => {
  it("groups adjacent teammates without moving messages across another teammate", () => {
    const feed = buildRunFeed({
      events: [
        ev({ kind: "phase", phase: "reading" }),
        ev({ kind: "scene_ready" }),
        ev({ kind: "phase", phase: "drafting" }),
        ev({ kind: "phase", phase: "checking" }),
        ev({ kind: "phase", phase: "reading", spanId: "s2" }),
      ],
      sceneBriefs: [],
    })
    const groups = groupRunFeed(Object.freeze(feed))
    expect(groups.map((group) => group.persona)).toEqual(["drafter", "reviewer", "drafter"])
    expect(groups.map((group) => group.id)).toEqual([feed[0].id, feed[3].id, feed[4].id])
    expect(groups.map((group) => group.at)).toEqual([feed[0].at, feed[3].at, feed[4].at])
    const messages = groups.flatMap((group) =>
      group.parts.flatMap((part) => part.kind === "activity" ? part.messages : [part.message]),
    )
    expect(messages).toEqual(feed)
    messages.forEach((message, index) => expect(message).toBe(feed[index]))
  })

  it("bundles routine phases but leaves notes, drafts, and outcomes as messages", () => {
    const feed = buildRunFeed({
      events: [
        ev({ kind: "phase", phase: "reading" }),
        ev({ kind: "phase", phase: "reading", spanId: "s2" }),
        ev({ kind: "scene_ready" }),
        ev({ kind: "phase", phase: "drafting" }),
        ev({ kind: "drafts_staged", details: { count: 3 } }),
        ev({ kind: "span_outcome", status: "failed", details: { reasons: ["model refused"] } }),
      ],
      sceneBriefs: [],
    })
    const groups = groupRunFeed(feed)
    expect(groups[0].parts).toEqual([
      { kind: "activity", id: feed[0].id, messages: feed.slice(0, 2) },
      { kind: "message", message: feed[2] },
      { kind: "activity", id: feed[3].id, messages: [feed[3]] },
    ])
    expect(groups[1].parts).toEqual([
      { kind: "message", message: feed[4] },
      { kind: "message", message: feed[5] },
    ])
  })

  it("handles an empty feed", () => {
    expect(groupRunFeed(buildRunFeed({ events: [], sceneBriefs: [] }))).toEqual([])
  })
})

describe("groupFeedByPassage", () => {
  const m = (id: string, body: TeamFeedMessage["body"]): TeamFeedMessage => ({
    id, persona: "coordinator", at: "2026-09-30T00:00:00Z", body, raw: { kind: "x", details: {} },
  })
  const passage = (span: string, outcome: "done" | "partial" | "failed", drafts = 4) => [
    m(`${span}-start`, { kind: "started", spanLabel: span }),
    m(`${span}-phase`, { kind: "phase", region: "drafting", spanLabel: span }),
    m(`${span}-drafts`, { kind: "draftsStaged", spanLabel: span, count: drafts }),
    m(`${span}-out`, { kind: "outcome", spanLabel: span, status: outcome, reasons: [] }),
  ]

  // A long run reads like a PR timeline: finished, clean passages fold to one
  // line so the eye lands on the ones that need a person.
  it("folds a finished clean passage and keeps a failed one open", () => {
    const sections = groupFeedByPassage([...passage("MRK 1:1–1:8", "done"), ...passage("MRK 1:9–1:15", "failed")], new Set())
    expect(sections.map((s) => [s.spanLabel, s.notable, s.drafts, s.outcome])).toEqual([
      ["MRK 1:1–1:8", false, 4, "done"],
      ["MRK 1:9–1:15", true, 4, "failed"],
    ])
  })

  it("keeps a passage open when any of its drafts needs a human", () => {
    const [section] = groupFeedByPassage(passage("MRK 2:1–2:12", "done"), new Set(["MRK 2:1–2:12"]))
    expect(section.notable).toBe(true)
  })

  it("keeps the passage still in progress open", () => {
    const sections = groupFeedByPassage(
      [...passage("A", "done"), m("b-start", { kind: "started", spanLabel: "B" })],
      new Set(),
    )
    expect(sections.map((s) => s.notable)).toEqual([false, true])
  })

  it("keeps concurrently drafted passages whole even when their events interleave", () => {
    const [a, b] = [passage("A", "done"), passage("B", "done")]
    const interleaved = a.flatMap((message, i) => [message, b[i]])
    const sections = groupFeedByPassage(interleaved, new Set())
    expect(sections.map((s) => [s.spanLabel, s.messages.length])).toEqual([["A", 4], ["B", 4]])
  })

  it("gives messages with no passage their own always-open section, in order", () => {
    const sections = groupFeedByPassage(
      [m("r", { kind: "phase", region: "reading", spanLabel: null }), ...passage("A", "done")],
      new Set(),
    )
    expect(sections.map((s) => [s.spanLabel, s.notable])).toEqual([[null, true], ["A", false]])
  })
})
