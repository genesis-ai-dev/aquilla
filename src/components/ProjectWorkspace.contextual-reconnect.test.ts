import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  reconcileContextualAfterRealtimeOpen,
  reconcileContextualDraftsAfterAppliedEvent,
} from "./ProjectWorkspace"
import {
  attachContextualRun,
  getContextualRunProgress,
  getContextualRunState,
  resetContextualRunStore,
  setContextualTransport,
  type ContextualRunSnapshot,
} from "@/lib/contextual/run-store"
import {
  attachContextualDrafts,
  getContextualDraftFor,
  hydrateContextualDrafts,
  resetContextualDraftsStore,
} from "@/lib/contextual/drafts-store"

const PROJECT = "project-reconnect"
const FILE = "file-reconnect"
const RUN = "01920000-0000-7000-8000-000000000001"

function snapshot(status: "running" | "parked", done: number): ContextualRunSnapshot {
  return {
    runId: RUN,
    fileId: FILE,
    status,
    phase: status === "running" ? "Drafting…" : null,
    spanLabel: status === "running" ? "MRK 1:1–1:2" : null,
    done,
    total: 1,
    failed: 0,
    activeDirections: [],
  }
}

beforeEach(() => {
  resetContextualRunStore()
  resetContextualDraftsStore()
})

describe("Autopilot realtime reconnect reconciliation", () => {
  it("replaces missed live state and draft frames from durable snapshots", async () => {
    const fetchSnapshot = vi.fn()
      .mockResolvedValueOnce({ available: true, run: snapshot("running", 0) })
      .mockResolvedValueOnce({ available: true, run: snapshot("parked", 1) })
    setContextualTransport({
      fetchSnapshot,
      start: vi.fn(async () => ({ runId: RUN })),
      pause: vi.fn(async () => {}),
      resume: vi.fn(async () => {}),
      terminate: vi.fn(async () => {}),
    })
    await attachContextualRun(PROJECT, FILE)

    const scope = attachContextualDrafts(PROJECT, FILE, "")
    hydrateContextualDrafts(scope, [
      { draftId: "draft-old", runId: RUN, cellId: "c1", text: "old local text" },
    ])

    await reconcileContextualAfterRealtimeOpen({
      projectId: PROJECT,
      currentFileId: FILE,
      draftScope: scope,
      attachRun: attachContextualRun,
      refreshDrafts: async (capturedScope) => {
        hydrateContextualDrafts(capturedScope, [
          { draftId: "draft-new", runId: RUN, cellId: "c1", text: "authoritative text" },
        ])
      },
    })

    expect(fetchSnapshot).toHaveBeenCalledTimes(2)
    expect(getContextualRunState()).toMatchObject({
      projectId: PROJECT,
      fileId: FILE,
      runId: RUN,
      status: "parked",
    })
    expect(getContextualRunProgress()).toEqual({ done: 1, total: 1, failed: 0 })
    expect(getContextualDraftFor(PROJECT, FILE, "", "c1")).toMatchObject({
      draftId: "draft-new",
      text: "authoritative text",
    })
  })

  it("does not hydrate an unsupported lane on reconnect", async () => {
    const scope = attachContextualDrafts(PROJECT, FILE, "fr")
    const attachRun = vi.fn(async () => {})
    const refreshDrafts = vi.fn(async () => {})

    await reconcileContextualAfterRealtimeOpen({
      projectId: PROJECT,
      currentFileId: FILE,
      draftScope: scope,
      attachRun,
      refreshDrafts,
    })

    expect(attachRun).not.toHaveBeenCalled()
    expect(refreshDrafts).not.toHaveBeenCalled()
  })

  it("refreshes the mounted default-lane drafts after the target commit projection lands", async () => {
    const scope = attachContextualDrafts(PROJECT, FILE, "")
    const refreshDrafts = vi.fn(async () => {})

    await reconcileContextualDraftsAfterAppliedEvent({
      projectId: PROJECT,
      currentFileId: FILE,
      draftScope: scope,
      event: {
        kind: "target.cell.commit",
        projectId: PROJECT,
        fileId: FILE,
      },
      refreshDrafts,
    })

    expect(refreshDrafts).toHaveBeenCalledOnce()
    expect(refreshDrafts).toHaveBeenCalledWith(scope)
  })

  it.each([
    ["source commit", "source.cell.commit", PROJECT, FILE, ""],
    ["another project", "target.cell.commit", "project-other", FILE, ""],
    ["another file", "target.cell.commit", PROJECT, "file-other", ""],
    ["unsupported lane", "target.cell.commit", PROJECT, FILE, "fr"],
  ])("does not refresh for %s", async (_label, kind, eventProjectId, eventFileId, lane) => {
    const scope = attachContextualDrafts(PROJECT, FILE, lane)
    const refreshDrafts = vi.fn(async () => {})

    await reconcileContextualDraftsAfterAppliedEvent({
      projectId: PROJECT,
      currentFileId: FILE,
      draftScope: scope,
      event: { kind, projectId: eventProjectId, fileId: eventFileId },
      refreshDrafts,
    })

    expect(refreshDrafts).not.toHaveBeenCalled()
  })
})
