/**
 * ws-frames.test.ts — cross-boundary test (AGENTS.md rule 12): a raw
 * `contextual.activity` WS frame, exactly as the sync-worker DO broadcasts it
 * ({ t, project, frame }), goes through the REAL client parse path
 * (parseProjectWsMessage in ws-reconciler.ts — the same function every live
 * socket frame passes through) and its `frame` payload feeds
 * applyRemoteFrame, mirroring ProjectWorkspace's onMessage branch. Asserts
 * the run-store mirror lands in the right state.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parseProjectWsMessage } from "@/lib/sync/ws-reconciler"
import {
  applyRemoteFrame,
  attachContextualRun,
  getContextualRunProgress,
  getContextualRunState,
  resetContextualRunStore,
  setContextualTransport,
} from "./run-store"
import {
  applyContextualDraftsFrame,
  attachContextualDrafts,
  getContextualDraftFor,
  hydrateContextualDrafts,
  resetContextualDraftsStore,
} from "./drafts-store"

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
  applyRemoteFrame(parsed.project, parsed.frame)
}

afterEach(() => {
  resetContextualRunStore()
  resetContextualDraftsStore()
})

describe("contextual.activity WS frames → run-store", () => {
  beforeEach(async () => {
    setContextualTransport({
      fetchSnapshot: async () => ({ available: true, run: null }),
      start: async () => ({ runId: RUN_ID }),
      pause: async () => {},
      resume: async () => {},
      terminate: async () => {},
    })
    await attachContextualRun(PROJECT, "file-1")
  })

  it("run.state frame adopts the run and updates progress", () => {
    dispatch({
      t: "contextual.activity",
      project: PROJECT,
      frame: {
        type: "contextual.run.state",
        runId: RUN_ID,
        fileId: "file-1",
        targetLang: "",
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
        targetLang: "",
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
        targetLang: "",
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
        targetLang: "",
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
        targetLang: "",
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
        targetLang: "",
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
      frame: { type: "contextual.run.state", runId: RUN_ID, fileId: "f", targetLang: "", status: "starting", done: 0, total: 1 },
    }))).toBeNull()
    // Lane provenance is mandatory during rolling deploys; guessing the
    // default lane could let a legacy multilingual failure replace this pill.
    expect(parseProjectWsMessage(JSON.stringify({
      t: "contextual.activity",
      project: PROJECT,
      frame: { type: "contextual.run.state", runId: RUN_ID, fileId: "f", status: "failed", done: 0, total: 1 },
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

  it("parses lane provenance but keeps a non-default run out of the default-lane mirror", () => {
    dispatch({
      t: "contextual.activity",
      project: PROJECT,
      frame: {
        type: "contextual.run.state",
        runId: RUN_ID,
        fileId: "file-1",
        targetLang: "fr",
        status: "failed",
        done: 0,
        total: 1,
        failed: 1,
      },
    })

    expect(getContextualRunState()).toMatchObject({ runId: null, status: "idle" })
    expect(getContextualRunProgress()).toEqual({ done: 0, total: 0, failed: 0 })
  })

  it("adopts a named-lane run.state frame when the editor is attached to that lane", async () => {
    await attachContextualRun(PROJECT, "file-1", "fr")
    dispatch({
      t: "contextual.activity",
      project: PROJECT,
      frame: {
        type: "contextual.run.state",
        runId: RUN_ID,
        fileId: "file-1",
        targetLang: "fr",
        status: "running",
        done: 2,
        total: 9,
      },
    })
    expect(getContextualRunState()).toMatchObject({ runId: RUN_ID, status: "running" })
    expect(getContextualRunProgress()).toEqual({ done: 2, total: 9, failed: 0 })
  })
})

describe("contextual.activity WS draft frames → scoped draft mirror", () => {
  function parsedDraft(project: string, text: string, targetLang = "", runId = RUN_ID) {
    const parsed = parseProjectWsMessage(JSON.stringify({
      t: "contextual.activity",
      project,
      frame: {
        type: "contextual.drafts",
        runId,
        fileId: "shared-file",
        targetLang,
        spanLabel: "LUK 1:1–1:8",
        drafts: [{ draftId: `draft-${project}`, cellId: "cell-1", text }],
      },
    }))
    if (!parsed || parsed.t !== "contextual.activity" || parsed.frame.type !== "contextual.drafts") {
      throw new Error("draft frame did not survive the real WebSocket ingress parser")
    }
    return { project: parsed.project, frame: parsed.frame }
  }

  it("accepts only the attached project/file default lane, even when projects reuse a file id", () => {
    attachContextualDrafts("project-a", "shared-file", "")
    const current = parsedDraft("project-a", "project A text")
    applyContextualDraftsFrame(current.project, current.frame, RUN_ID)
    expect(getContextualDraftFor("project-a", "shared-file", "", "cell-1")?.text).toBe("project A text")

    attachContextualDrafts("project-b", "shared-file", "")
    const lateA = parsedDraft("project-a", "late private project A text")
    applyContextualDraftsFrame(lateA.project, lateA.frame, RUN_ID)

    expect(getContextualDraftFor("project-b", "shared-file", "", "cell-1")).toBeUndefined()
    expect(getContextualDraftFor("project-a", "shared-file", "", "cell-1")).toBeUndefined()
  })

  it("drops the default-lane wire payload while a multilingual editor lane is attached", () => {
    attachContextualDrafts(PROJECT, "shared-file", "fr")
    const parsed = parsedDraft(PROJECT, "default-only text")

    applyContextualDraftsFrame(parsed.project, parsed.frame, RUN_ID)

    expect(getContextualDraftFor(PROJECT, "shared-file", "fr", "cell-1")).toBeUndefined()
  })

  it("rejects missing lane provenance at ingress and drops an explicit legacy lane", () => {
    expect(parseProjectWsMessage(JSON.stringify({
      t: "contextual.activity",
      project: PROJECT,
      frame: {
        type: "contextual.drafts",
        runId: RUN_ID,
        fileId: "shared-file",
        spanLabel: "LUK 1:1–1:8",
        drafts: [{ draftId: "missing-lane", cellId: "cell-1", text: "ambiguous" }],
      },
    }))).toBeNull()

    attachContextualDrafts(PROJECT, "shared-file", "")
    const legacyLane = parsedDraft(PROJECT, "legacy fr text", "fr")
    applyContextualDraftsFrame(legacyLane.project, legacyLane.frame, RUN_ID)

    expect(getContextualDraftFor(PROJECT, "shared-file", "", "cell-1")).toBeUndefined()
  })

  it("keeps run B REST truth when a delayed run A wire burst arrives", () => {
    const scope = attachContextualDrafts(PROJECT, "shared-file", "")
    hydrateContextualDrafts(scope, [{
      draftId: "draft-b",
      runId: "run-b",
      cellId: "cell-1",
      text: "current run B proposal",
    }])
    const delayedA = parsedDraft(PROJECT, "stale run A proposal", "", "run-a")

    const result = applyContextualDraftsFrame(delayedA.project, delayedA.frame, "run-b")

    expect(result.needsRefetch).toBe(true)
    expect(getContextualDraftFor(PROJECT, "shared-file", "", "cell-1")).toMatchObject({
      runId: "run-b",
      text: "current run B proposal",
    })
  })
})
