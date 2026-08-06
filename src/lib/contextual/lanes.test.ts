// Wave lanes in the run-store mirror. WHY: the server now runs several
// passages at once, so "the current passage" stopped being a true statement.
// A UI that keeps pretending otherwise either flickers between passages or
// reports the slowest one as if it were the whole run. These tests pin the
// three rules that keep a wide wave legible:
//
//   1. A lane opens on span.start — BEFORE any model output — because the
//      closure loop is the longest phase and used to render as dead air.
//   2. The run's phase readout follows the FURTHEST lane, not the last frame
//      to arrive, so a wave never looks stuck on its slowest passage.
//   3. Lanes close on their own span frame and are cleared by any terminal
//      run state, so finished work can never sit on screen looking live.

import { describe, it, expect, beforeEach } from "vitest"
import {
  applyRemoteFrame,
  getContextualRunState,
  resetContextualRunStore,
} from "./run-store"

const RUN = "01920000-0000-7000-8000-000000000001"

const start = (spanId: string, spanLabel: string) =>
  ({ type: "contextual.span.start" as const, runId: RUN, fileId: "file-1", spanId, spanLabel })

const phase = (spanId: string, p: "reading" | "drafting" | "checking" | "staging") =>
  ({ type: "contextual.phase" as const, runId: RUN, spanId, spanLabel: spanId, phase: p })

const done = (spanId: string) =>
  ({
    type: "contextual.span" as const,
    runId: RUN,
    spanId,
    spanLabel: spanId,
    staged: 3,
    skipped: 0,
    verdictSummary: "complete",
  })

beforeEach(() => {
  resetContextualRunStore()
})

describe("lane tracking", () => {
  it("opens a lane per passage and keeps them all in flight", () => {
    applyRemoteFrame(start("s1", "LUK 1:1–1:8"))
    applyRemoteFrame(start("s2", "LUK 2:1–2:9"))
    applyRemoteFrame(start("s3", "LUK 3:1–3:7"))

    const lanes = getContextualRunState().lanes
    expect(lanes.map((l) => l.spanId)).toEqual(["s1", "s2", "s3"])
    expect(lanes.every((l) => l.phase === "reading")).toBe(true)
  })

  it("ignores a duplicate span.start for a lane already open", () => {
    applyRemoteFrame(start("s1", "LUK 1:1–1:8"))
    applyRemoteFrame(phase("s1", "drafting"))
    applyRemoteFrame(start("s1", "LUK 1:1–1:8"))

    const lanes = getContextualRunState().lanes
    expect(lanes).toHaveLength(1)
    // The duplicate must not reset progress the lane already made.
    expect(lanes[0].phase).toBe("drafting")
  })

  it("opens a lane from a phase frame when span.start was lost", () => {
    // Frames are best-effort; a dropped open must not make live work invisible.
    applyRemoteFrame(phase("s9", "checking"))
    expect(getContextualRunState().lanes).toMatchObject([{ spanId: "s9", phase: "checking" }])
  })

  it("reports the furthest lane's phase, not the slowest or the latest frame", () => {
    applyRemoteFrame(start("s1", "a"))
    applyRemoteFrame(start("s2", "b"))
    applyRemoteFrame(phase("s2", "checking"))
    // s1 is still reading, and its frame arrived most recently.
    applyRemoteFrame(phase("s1", "reading"))

    expect(getContextualRunState().phase).toBe("Checking…")
  })

  it("closes only the lane its span frame names", () => {
    applyRemoteFrame(start("s1", "a"))
    applyRemoteFrame(start("s2", "b"))
    applyRemoteFrame(done("s1"))

    expect(getContextualRunState().lanes.map((l) => l.spanId)).toEqual(["s2"])
  })

  it("falls back to closing the oldest lane when a span frame carries no id", () => {
    // Backwards compatibility: a server mid-deploy still emits the old shape.
    applyRemoteFrame(start("s1", "a"))
    applyRemoteFrame(start("s2", "b"))
    applyRemoteFrame({
      type: "contextual.span",
      runId: RUN,
      spanLabel: "a",
      staged: 1,
      skipped: 0,
      verdictSummary: "complete",
    })
    expect(getContextualRunState().lanes.map((l) => l.spanId)).toEqual(["s2"])
  })

  it("advances a lane to drafting when its scene brief lands", () => {
    applyRemoteFrame(start("s1", "a"))
    applyRemoteFrame({
      type: "contextual.scene",
      runId: RUN,
      sceneBriefId: "brief-1",
      spanLabel: "a",
      ambiguityCount: 2,
      spanId: "s1",
    })
    expect(getContextualRunState().lanes[0].phase).toBe("drafting")
    expect(getContextualRunState().phase).toBe("Drafting…")
  })

  it("clears every lane when the run reaches a terminal state", () => {
    applyRemoteFrame(start("s1", "a"))
    applyRemoteFrame(start("s2", "b"))
    applyRemoteFrame({
      type: "contextual.run.state",
      runId: RUN,
      fileId: "file-1",
      status: "parked",
      done: 4,
      total: 4,
    })

    const state = getContextualRunState()
    expect(state.lanes).toEqual([])
    expect(state.phase).toBeNull()
  })

  it("keeps lanes across a still-running state frame for the same run", () => {
    applyRemoteFrame(start("s1", "a"))
    applyRemoteFrame(phase("s1", "drafting"))
    applyRemoteFrame({
      type: "contextual.run.state",
      runId: RUN,
      fileId: "file-1",
      status: "running",
      done: 1,
      total: 4,
    })

    const state = getContextualRunState()
    expect(state.lanes).toHaveLength(1)
    expect(state.phase).toBe("Drafting…")
  })

  it("drops lane frames from a superseded run", () => {
    const NEWER = "01930000-0000-7000-8000-000000000002"
    applyRemoteFrame({
      type: "contextual.run.state",
      runId: NEWER,
      fileId: "file-1",
      status: "running",
      done: 0,
      total: 3,
    })
    applyRemoteFrame(start("stale", "old passage"))
    expect(getContextualRunState().lanes).toEqual([])
  })
})
