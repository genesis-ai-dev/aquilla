import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  applyRemoteFrame as applyFrame,
  attachContextualRun,
  dismissContextualRunSummary,
  getContextualRunProgress,
  getContextualRunState,
  requestPauseContextualRun,
  resetContextualRunStore,
  resumeContextualRun,
  setContextualTransport,
  startContextualRun,
  terminateContextualRun,
  type ContextualRunSnapshot,
  type ContextualFrame,
  type ContextualTransport,
} from "./run-store"

// UUIDv7-ish ids: time-ordered ⇒ lexicographic order is chronological.
const RUN_A = "01920000-0000-7000-8000-000000000001"
const RUN_B = "01930000-0000-7000-8000-000000000002" // newer than RUN_A

function applyRemoteFrame(frame: ContextualFrame): void {
  applyFrame("p1", frame)
}

function makeTransport(overrides: Partial<ContextualTransport> = {}): ContextualTransport {
  return {
    fetchSnapshot: vi.fn(async () => ({ available: true, run: null })),
    start: vi.fn(async () => ({ runId: RUN_A })),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    terminate: vi.fn(async () => {}),
    ...overrides,
  }
}

function runningFrame(
  runId: string,
  patch: Partial<{ done: number; total: number; failed: number; targetLang: string }> = {},
) {
  return {
    type: "contextual.run.state" as const,
    runId,
    fileId: "file-1",
    targetLang: patch.targetLang ?? "",
    status: "running" as const,
    done: patch.done ?? 0,
    total: patch.total ?? 10,
    ...(patch.failed !== undefined ? { failed: patch.failed } : {}),
  }
}

beforeEach(async () => {
  resetContextualRunStore()
  // ProjectWorkspace attaches the open file before accepting its project-wide
  // WebSocket fan-out. Mirror that producer boundary in every frame test.
  await attachContextualRun("p1", "file-1")
})

describe("transport stub (default)", () => {
  it("attach reports unavailable → idle/setup state", async () => {
    await attachContextualRun("p1", "file-1")
    const s = getContextualRunState()
    expect(s.available).toBe(false)
    expect(s.status).toBe("idle")
    expect(s.fileId).toBe("file-1")
  })

  it("start against the stub fails soft — back to idle, no throw", async () => {
    const ok = await startContextualRun("p1", "file-1")
    expect(ok).toBe(false)
    expect(getContextualRunState().status).toBe("idle")
  })
})

describe("snapshot hydration", () => {
  it("adopts the transport's run snapshot", async () => {
    const run: ContextualRunSnapshot = {
      runId: RUN_A,
      fileId: "file-1",
      status: "running",
      phase: "Drafting…",
      spanLabel: "LUK 1:1–1:8",
      done: 3,
      total: 12,
      failed: 1,
      activeDirections: ["Keep dialogue formal"],
    }
    setContextualTransport(makeTransport({ fetchSnapshot: async () => ({ available: true, run }) }))
    await attachContextualRun("p1", "file-1")
    const s = getContextualRunState()
    expect(s).toMatchObject({
      available: true, runId: RUN_A, status: "running",
      phase: "Drafting…", spanLabel: "LUK 1:1–1:8",
      activeDirections: ["Keep dialogue formal"],
    })
    expect(getContextualRunProgress()).toEqual({ done: 3, total: 12, failed: 1 })
  })

  it("available with no run → idle but available (play affordance live)", async () => {
    setContextualTransport(makeTransport())
    await attachContextualRun("p1", "file-1")
    expect(getContextualRunState()).toMatchObject({ available: true, status: "idle", runId: null })
  })

  it("a stale attach resolving after a newer one is discarded", async () => {
    let resolveFirst!: (v: { available: boolean }) => void
    const first = new Promise<{ available: boolean }>((r) => { resolveFirst = r })
    const transport = makeTransport()
    const fetchSnapshot = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ available: true, run: null })
    setContextualTransport({ ...transport, fetchSnapshot })
    const p1 = attachContextualRun("p1", "file-old")
    await attachContextualRun("p1", "file-new")
    resolveFirst({ available: false })
    await p1
    expect(getContextualRunState()).toMatchObject({ available: true, fileId: "file-new" })
  })

  it("adopts an older valid snapshot after switching away from a newer run on another file", async () => {
    applyRemoteFrame({ ...runningFrame(RUN_B), fileId: "file-1" })
    const olderOtherFile: ContextualRunSnapshot = {
      runId: RUN_A,
      fileId: "file-2",
      status: "paused",
      phase: null,
      spanLabel: null,
      done: 2,
      total: 8,
      failed: 0,
      activeDirections: [],
    }
    setContextualTransport(makeTransport({
      fetchSnapshot: async () => ({ available: true, run: olderOtherFile }),
    }))

    await attachContextualRun("p1", "file-2")

    expect(getContextualRunState()).toMatchObject({
      fileId: "file-2",
      runId: RUN_A,
      status: "paused",
    })
    expect(getContextualRunProgress()).toEqual({ done: 2, total: 8, failed: 0 })
  })

  it("resets the monotonic guard when projects reuse the same file id", async () => {
    const newerProjectARun: ContextualRunSnapshot = {
      runId: RUN_B,
      fileId: "shared-file-id",
      status: "running",
      phase: "Drafting…",
      spanLabel: "A 1:1",
      done: 7,
      total: 9,
      failed: 0,
      activeDirections: [],
    }
    const olderProjectBRun: ContextualRunSnapshot = {
      ...newerProjectARun,
      runId: RUN_A,
      status: "paused",
      phase: null,
      spanLabel: null,
      done: 2,
      total: 6,
    }
    const fetchSnapshot = vi.fn(async (projectId: string) => ({
      available: true,
      run: projectId === "project-a" ? newerProjectARun : olderProjectBRun,
    }))
    setContextualTransport(makeTransport({ fetchSnapshot }))

    await attachContextualRun("project-a", "shared-file-id")
    await attachContextualRun("project-b", "shared-file-id")

    expect(getContextualRunState()).toMatchObject({
      projectId: "project-b",
      fileId: "shared-file-id",
      runId: RUN_A,
      status: "paused",
    })
    expect(getContextualRunProgress()).toEqual({ done: 2, total: 6, failed: 0 })
  })

  it("rejects a late project-A frame after project B attaches the same file id", async () => {
    await attachContextualRun("project-b", "file-1")

    applyFrame("project-a", runningFrame(RUN_B, { done: 8, total: 9 }))

    expect(getContextualRunState()).toMatchObject({
      projectId: "project-b",
      fileId: "file-1",
      runId: null,
      status: "idle",
    })
    expect(getContextualRunProgress()).toEqual({ done: 0, total: 0, failed: 0 })
  })
})

describe("frame application", () => {
  it("run.state frame updates state and progress", () => {
    applyRemoteFrame(runningFrame(RUN_A, { done: 2, total: 8, failed: 1 }))
    const s = getContextualRunState()
    expect(s).toMatchObject({ available: true, runId: RUN_A, fileId: "file-1", status: "running" })
    expect(s.phase).toBe("Reading context…")
    expect(getContextualRunProgress()).toEqual({ done: 2, total: 8, failed: 1 })
  })

  it("fails closed on a sibling-language or missing run-state lane", () => {
    applyRemoteFrame(runningFrame(RUN_A, { done: 2, total: 8 }))

    applyRemoteFrame(runningFrame(RUN_B, {
      done: 7,
      total: 9,
      targetLang: "fr",
    }))
    applyRemoteFrame({
      type: "contextual.run.state",
      runId: RUN_B,
      fileId: "file-1",
      status: "failed",
      done: 9,
      total: 9,
    } as unknown as ContextualFrame)

    expect(getContextualRunState()).toMatchObject({
      runId: RUN_A,
      fileId: "file-1",
      status: "running",
    })
    expect(getContextualRunProgress()).toEqual({ done: 2, total: 8, failed: 0 })
  })

  it("adopts a named-lane run when the editor is attached to that lane", async () => {
    await attachContextualRun("p1", "file-1", "fr")
    applyRemoteFrame(runningFrame(RUN_A, { done: 2, total: 8, targetLang: "fr" }))
    expect(getContextualRunState()).toMatchObject({
      runId: RUN_A,
      status: "running",
    })
    expect(getContextualRunProgress()).toEqual({ done: 2, total: 8, failed: 0 })

    applyRemoteFrame(runningFrame(RUN_B, { done: 1, total: 4, targetLang: "" }))
    expect(getContextualRunState().runId).toBe(RUN_A)
  })

  it("scene frame sets span label and drafting phase; span frame moves on", () => {
    applyRemoteFrame(runningFrame(RUN_A))
    applyRemoteFrame({
      type: "contextual.scene", runId: RUN_A,
      sceneBriefId: "sb-1", spanLabel: "LUK 1:1–1:8", ambiguityCount: 2,
    })
    expect(getContextualRunState()).toMatchObject({ spanLabel: "LUK 1:1–1:8", phase: "Drafting…" })
    applyRemoteFrame({
      type: "contextual.span", runId: RUN_A,
      spanLabel: "LUK 1:1–1:8", staged: 8, skipped: 0, verdictSummary: "ok",
    })
    expect(getContextualRunState().phase).toBe("Reading context…")
  })

  it("progress frames do not touch state when only counters change", () => {
    applyRemoteFrame(runningFrame(RUN_A, { done: 1 }))
    const before = getContextualRunState()
    applyRemoteFrame(runningFrame(RUN_A, { done: 2 }))
    const after = getContextualRunState()
    // Same run, same status/phase/span — chrome fields unchanged.
    expect(after.status).toBe(before.status)
    expect(after.phase).toBe(before.phase)
    expect(after.spanLabel).toBe(before.spanLabel)
    expect(getContextualRunProgress().done).toBe(2)
  })

  it("parked and done frames clear the phase readout", () => {
    applyRemoteFrame(runningFrame(RUN_A))
    applyRemoteFrame({ ...runningFrame(RUN_A, { done: 10 }), status: "parked" })
    expect(getContextualRunState()).toMatchObject({ status: "parked", phase: null })
  })

  it("drops another file's newer run and all file-less frames for it", () => {
    applyRemoteFrame(runningFrame(RUN_A, { done: 2, total: 8 }))
    applyRemoteFrame({ ...runningFrame(RUN_B, { done: 7, total: 9 }), fileId: "file-2" })
    applyRemoteFrame({
      type: "contextual.scene",
      runId: RUN_B,
      sceneBriefId: "other-scene",
      spanLabel: "OTHER 1:1",
      ambiguityCount: 0,
    })

    expect(getContextualRunState()).toMatchObject({
      fileId: "file-1",
      runId: RUN_A,
      spanLabel: null,
    })
    expect(getContextualRunProgress()).toEqual({ done: 2, total: 8, failed: 0 })
  })
})

describe("runId supersession (monotonic UUIDv7 guard)", () => {
  it("frames from a superseded run are dropped", () => {
    applyRemoteFrame(runningFrame(RUN_B, { done: 5, total: 20 }))
    applyRemoteFrame(runningFrame(RUN_A, { done: 99, total: 99 })) // older run
    expect(getContextualRunState().runId).toBe(RUN_B)
    expect(getContextualRunProgress()).toEqual({ done: 5, total: 20, failed: 0 })
  })

  it("a newer runId supersedes: adopted, span context reset", () => {
    applyRemoteFrame(runningFrame(RUN_A))
    applyRemoteFrame({
      type: "contextual.scene", runId: RUN_A,
      sceneBriefId: "sb-1", spanLabel: "LUK 1:1–1:8", ambiguityCount: 0,
    })
    applyRemoteFrame(runningFrame(RUN_B, { done: 0, total: 4 }))
    const s = getContextualRunState()
    expect(s.runId).toBe(RUN_B)
    expect(s.spanLabel).toBeNull()
    expect(getContextualRunProgress().total).toBe(4)
  })

  it("scene/span frames for an older run are dropped too", () => {
    applyRemoteFrame(runningFrame(RUN_B))
    applyRemoteFrame({
      type: "contextual.scene", runId: RUN_A,
      sceneBriefId: "sb-9", spanLabel: "OLD 9:9", ambiguityCount: 0,
    })
    expect(getContextualRunState().spanLabel).toBeNull()
  })
})

describe("pause vs terminate", () => {
  it("accepts the backend's producer-shaped pausing frame", () => {
    applyRemoteFrame({
      type: "contextual.run.state",
      runId: RUN_A,
      fileId: "file-1",
      targetLang: "",
      status: "pausing",
      done: 3,
      total: 10,
      failed: 1,
    })

    expect(getContextualRunState()).toMatchObject({
      runId: RUN_A,
      fileId: "file-1",
      status: "pausing",
    })
    expect(getContextualRunProgress()).toEqual({ done: 3, total: 10, failed: 1 })
  })

  it("pause request shows 'pausing' and sticks over running frames until parked", async () => {
    const transport = makeTransport()
    setContextualTransport(transport)
    applyRemoteFrame(runningFrame(RUN_A))
    await requestPauseContextualRun()
    expect(transport.pause).toHaveBeenCalledWith(RUN_A)
    expect(getContextualRunState().status).toBe("pausing")
    // Workflow hasn't parked yet — a running frame must not flip the pill back.
    applyRemoteFrame(runningFrame(RUN_A, { done: 3 }))
    expect(getContextualRunState().status).toBe("pausing")
    // The paused confirmation lands.
    applyRemoteFrame({ ...runningFrame(RUN_A, { done: 3 }), status: "paused" })
    expect(getContextualRunState().status).toBe("paused")
  })

  it("paused resumes; terminated does not", async () => {
    const transport = makeTransport()
    setContextualTransport(transport)
    applyRemoteFrame({ ...runningFrame(RUN_A), status: "paused" })
    await resumeContextualRun()
    expect(transport.resume).toHaveBeenCalledWith(RUN_A)
    expect(getContextualRunState().status).toBe("running")

    await terminateContextualRun()
    expect(transport.terminate).toHaveBeenCalledWith(RUN_A)
    expect(getContextualRunState().status).toBe("terminated")

    await resumeContextualRun()
    expect(transport.resume).toHaveBeenCalledTimes(1) // no resume after terminate
    expect(getContextualRunState().status).toBe("terminated")
  })

  it("terminate retains progress for the summary; dismiss clears it", async () => {
    setContextualTransport(makeTransport())
    applyRemoteFrame(runningFrame(RUN_A, { done: 4, total: 9, failed: 2 }))
    await terminateContextualRun()
    expect(getContextualRunProgress()).toEqual({ done: 4, total: 9, failed: 2 })
    dismissContextualRunSummary()
    expect(getContextualRunState()).toMatchObject({ status: "idle", runId: null, available: true })
    expect(getContextualRunProgress()).toEqual({ done: 0, total: 0, failed: 0 })
  })

  it("failed pause request reverts to running (run is honestly still going)", async () => {
    setContextualTransport(makeTransport({ pause: vi.fn(async () => { throw new Error("net") }) }))
    applyRemoteFrame(runningFrame(RUN_A))
    await requestPauseContextualRun()
    expect(getContextualRunState().status).toBe("running")
  })
})

describe("start", () => {
  it("adopts the server-minted runId optimistically", async () => {
    const transport = makeTransport()
    setContextualTransport(transport)
    await attachContextualRun("p1", "file-1")
    const ok = await startContextualRun("p1", "file-1")
    expect(ok).toBe(true)
    expect(transport.start).toHaveBeenCalledWith("p1", "file-1", undefined, "")
    expect(getContextualRunState()).toMatchObject({ runId: RUN_A, status: "running" })
  })

  it("forwards the attached language lane when starting", async () => {
    const transport = makeTransport()
    setContextualTransport(transport)
    await attachContextualRun("p1", "file-1", "fr")
    await startContextualRun("p1", "file-1")
    expect(transport.start).toHaveBeenCalledWith("p1", "file-1", undefined, "fr")
  })

  it("forwards the anchor cell so the first wave starts where the user is looking", async () => {
    const transport = makeTransport()
    setContextualTransport(transport)
    await attachContextualRun("p1", "file-1")
    await startContextualRun("p1", "file-1", "cell-42")
    expect(transport.start).toHaveBeenCalledWith("p1", "file-1", "cell-42", "")
  })
})
