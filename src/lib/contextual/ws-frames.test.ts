/**
 * ws-frames.test.ts — cross-boundary test (AGENTS.md rule 12): a raw
 * `contextual.activity` WS frame, exactly as the sync-worker DO broadcasts it
 * ({ t, project, frame }), goes through the REAL client parse path
 * (parseProjectWsMessage in ws-reconciler.ts — the same function every live
 * socket frame passes through) and its `frame` payload feeds
 * applyRemoteFrame, mirroring ProjectWorkspace's onMessage branch. Asserts
 * the run-store mirror lands in the right state.
 */

import { afterEach, describe, expect, it } from "vitest"
import { parseProjectWsMessage } from "@/lib/sync/ws-reconciler"
import {
  applyRemoteFrame,
  getContextualRunProgress,
  getContextualRunState,
  resetContextualRunStore,
} from "./run-store"

const PROJECT = "proj-1"
const RUN_ID = "0198c0de-0000-7000-8000-000000000001"

/** Serialize like the DO does, parse like the client does. */
function dispatch(raw: object): void {
  const parsed = parseProjectWsMessage(JSON.stringify(raw))
  if (!parsed) throw new Error("frame did not parse — wire contract broken")
  if (parsed.t !== "contextual.activity") throw new Error(`unexpected frame type ${parsed.t}`)
  // ProjectWorkspace's onMessage branch: project match, split draft bursts off
  // to the drafts store, then straight to the run store.
  expect(parsed.project).toBe(PROJECT)
  if (parsed.frame.type === "contextual.drafts") {
    throw new Error("draft bursts are covered by drafts-store.test.ts, not here")
  }
  applyRemoteFrame(parsed.frame)
}

afterEach(() => {
  resetContextualRunStore()
})

describe("contextual.activity WS frames → run-store", () => {
  it("run.state frame adopts the run and updates progress", () => {
    dispatch({
      t: "contextual.activity",
      project: PROJECT,
      frame: {
        type: "contextual.run.state",
        runId: RUN_ID,
        fileId: "file-1",
        status: "running",
        done: 3,
        total: 12,
        failed: 1,
      },
    })
    const state = getContextualRunState()
    expect(state.available).toBe(true)
    expect(state.runId).toBe(RUN_ID)
    expect(state.fileId).toBe("file-1")
    expect(state.status).toBe("running")
    expect(getContextualRunProgress()).toEqual({ done: 3, total: 12, failed: 1 })
  })

  it("scene frame flips the phase to drafting with the span label", () => {
    dispatch({
      t: "contextual.activity",
      project: PROJECT,
      frame: {
        type: "contextual.run.state",
        runId: RUN_ID,
        fileId: "file-1",
        status: "running",
        done: 0,
        total: 12,
      },
    })
    dispatch({
      t: "contextual.activity",
      project: PROJECT,
      frame: {
        type: "contextual.scene",
        runId: RUN_ID,
        sceneBriefId: "brief-1",
        spanLabel: "LUK 1:1–1:8",
        ambiguityCount: 2,
      },
    })
    const state = getContextualRunState()
    expect(state.spanLabel).toBe("LUK 1:1–1:8")
    expect(state.phase).toBe("Drafting…")
  })

  it("span frame returns the phase to reading; paused run.state parks the pill", () => {
    dispatch({
      t: "contextual.activity",
      project: PROJECT,
      frame: {
        type: "contextual.run.state",
        runId: RUN_ID,
        fileId: "file-1",
        status: "running",
        done: 4,
        total: 12,
      },
    })
    dispatch({
      t: "contextual.activity",
      project: PROJECT,
      frame: {
        type: "contextual.span",
        runId: RUN_ID,
        spanLabel: "LUK 1:1–1:8",
        staged: 7,
        skipped: 1,
        verdictSummary: "7 staged, 1 skipped",
      },
    })
    expect(getContextualRunState().phase).toBe("Reading context…")

    dispatch({
      t: "contextual.activity",
      project: PROJECT,
      frame: {
        type: "contextual.run.state",
        runId: RUN_ID,
        fileId: "file-1",
        status: "paused",
        done: 5,
        total: 12,
      },
    })
    expect(getContextualRunState().status).toBe("paused")
    expect(getContextualRunProgress().done).toBe(5)
  })

  it("frames from a superseded (older UUIDv7) run are dropped", () => {
    dispatch({
      t: "contextual.activity",
      project: PROJECT,
      frame: {
        type: "contextual.run.state",
        runId: RUN_ID,
        fileId: "file-1",
        status: "running",
        done: 6,
        total: 12,
      },
    })
    const olderRunId = "0198c0de-0000-7000-8000-000000000000"
    dispatch({
      t: "contextual.activity",
      project: PROJECT,
      frame: {
        type: "contextual.run.state",
        runId: olderRunId,
        fileId: "file-1",
        status: "failed",
        done: 1,
        total: 2,
      },
    })
    expect(getContextualRunState().runId).toBe(RUN_ID)
    expect(getContextualRunState().status).toBe("running")
    expect(getContextualRunProgress().done).toBe(6)
  })

  it("malformed frames are rejected by the wire parser, never reaching the store", () => {
    // Wrong status word
    expect(parseProjectWsMessage(JSON.stringify({
      t: "contextual.activity",
      project: PROJECT,
      frame: { type: "contextual.run.state", runId: RUN_ID, fileId: "f", status: "starting", done: 0, total: 1 },
    }))).toBeNull()
    // Missing runId
    expect(parseProjectWsMessage(JSON.stringify({
      t: "contextual.activity",
      project: PROJECT,
      frame: { type: "contextual.scene", sceneBriefId: "b", spanLabel: "s", ambiguityCount: 0 },
    }))).toBeNull()
    // Unknown frame type
    expect(parseProjectWsMessage(JSON.stringify({
      t: "contextual.activity",
      project: PROJECT,
      frame: { type: "contextual.mystery", runId: RUN_ID },
    }))).toBeNull()
    // No frame at all
    expect(parseProjectWsMessage(JSON.stringify({
      t: "contextual.activity",
      project: PROJECT,
    }))).toBeNull()
    expect(getContextualRunState().runId).toBeNull()
  })
})
