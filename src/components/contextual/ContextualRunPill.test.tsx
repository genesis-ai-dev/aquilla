import { describe, it, expect, beforeEach, vi } from "vitest"
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react"
import { ContextualRunPill } from "./ContextualRunPill"
import {
  applyRemoteFrame as applyFrame,
  attachContextualRun,
  resetContextualRunStore,
  setContextualTransport,
  type ContextualTransport,
  type ContextualFrame,
} from "@/lib/contextual/run-store"
import {
  attachContextualDrafts,
  hydrateContextualDrafts,
  resetContextualDraftsStore,
} from "@/lib/contextual/drafts-store"

vi.mock("./AutopilotActivityInspector", () => ({
  AutopilotActivityInspector: ({ open, canControl }: { open: boolean; canControl?: boolean }) => open
    ? <div role="dialog" aria-label="Autopilot activity" data-can-control={String(canControl)} />
    : null,
}))

const RUN = "01920000-0000-7000-8000-000000000001"

function applyRemoteFrame(frame: ContextualFrame): void {
  applyFrame("p1", frame)
}

function frame(status: "running" | "pausing" | "paused" | "parked" | "done" | "failed", patch: Partial<{ done: number; total: number; failed: number }> = {}) {
  return {
    type: "contextual.run.state" as const,
    runId: RUN,
    fileId: "file-1",
    targetLang: "",
    status,
    done: patch.done ?? 0,
    total: patch.total ?? 10,
    ...(patch.failed !== undefined ? { failed: patch.failed } : {}),
  }
}

function makeTransport(overrides: Partial<ContextualTransport> = {}): ContextualTransport {
  return {
    fetchSnapshot: vi.fn(async () => ({ available: true, run: null })),
    start: vi.fn(async () => ({ runId: RUN })),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    terminate: vi.fn(async () => {}),
    ...overrides,
  }
}

beforeEach(async () => {
  cleanup()
  resetContextualRunStore()
  resetContextualDraftsStore()
  await attachContextualRun("p1", "file-1")
})

describe("ContextualRunPill", () => {
  it("fails closed when control permission is omitted", () => {
    render(<ContextualRunPill projectId="p1" fileId="file-1" />)
    expect(screen.queryByTestId("contextual-run-pill")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Run Autopilot" })).not.toBeInTheDocument()
  })

  it("idle + backend unavailable: Play is clickable and opens setup (never disabled)", async () => {
    const onSetupNeeded = vi.fn()
    render(<ContextualRunPill projectId="p1" fileId="file-1" onSetupNeeded={onSetupNeeded} canControl />)
    const play = screen.getByRole("button", { name: "Run Autopilot" })
    expect(play).not.toBeDisabled()
    await act(async () => { fireEvent.click(play) })
    expect(onSetupNeeded).toHaveBeenCalledTimes(1)
  })

  it("Play during snapshot hydration starts the run instead of opening setup", async () => {
    resetContextualRunStore()
    let resolveSnap!: (value: { available: boolean; run: null }) => void
    const snap = new Promise<{ available: boolean; run: null }>((resolve) => {
      resolveSnap = resolve
    })
    const transport = makeTransport({
      fetchSnapshot: vi.fn(() => snap),
      start: vi.fn(async () => ({ runId: RUN })),
    })
    setContextualTransport(transport)
    const attaching = attachContextualRun("p1", "file-1")
    const onSetupNeeded = vi.fn()
    render(<ContextualRunPill projectId="p1" fileId="file-1" onSetupNeeded={onSetupNeeded} canControl />)

    fireEvent.click(screen.getByRole("button", { name: "Run Autopilot" }))
    expect(onSetupNeeded).not.toHaveBeenCalled()
    expect(transport.start).not.toHaveBeenCalled()

    await act(async () => {
      resolveSnap({ available: true, run: null })
      await attaching
    })

    await act(async () => {
      await Promise.resolve()
    })
    expect(onSetupNeeded).not.toHaveBeenCalled()
    expect(transport.start).toHaveBeenCalledWith("p1", "file-1", undefined, "")
  })

  it("announces a visible recovery message when starting fails", async () => {
    const transport = makeTransport({
      fetchSnapshot: vi.fn(async () => ({ available: true, run: null })),
      start: vi.fn(async () => { throw new Error("offline") }),
    })
    setContextualTransport(transport)
    await act(async () => { await attachContextualRun("p1", "file-1") })
    render(<ContextualRunPill projectId="p1" fileId="file-1" canControl />)

    fireEvent.click(screen.getByRole("button", { name: "Run Autopilot" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Autopilot couldn’t start. Try again or check AI setup.",
    )
    expect(screen.getByRole("button", { name: "Run Autopilot" })).toBeInTheDocument()
  })

  it("running: pause control, progress readout, span label click", () => {
    setContextualTransport(makeTransport())
    applyRemoteFrame(frame("running", { done: 3, total: 12 }))
    applyRemoteFrame({
      type: "contextual.scene", runId: RUN,
      sceneBriefId: "sb-1", spanLabel: "LUK 1:1–1:8", ambiguityCount: 1,
    })
    const onSpanClick = vi.fn()
    render(<ContextualRunPill projectId="p1" fileId="file-1" onSpanClick={onSpanClick} canControl />)
    expect(screen.getByRole("button", { name: "Pause after this passage" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "View Autopilot activity" })).toBeInTheDocument()
    expect(screen.getByText("3/12")).toBeInTheDocument()
    expect(screen.getByText(/Drafting…/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("LUK 1:1–1:8"))
    expect(onSpanClick).toHaveBeenCalledWith("LUK 1:1–1:8")
  })

  it("pause request shows the finishing message", async () => {
    const transport = makeTransport()
    setContextualTransport(transport)
    applyRemoteFrame(frame("running"))
    render(<ContextualRunPill projectId="p1" fileId="file-1" canControl />)
    fireEvent.click(screen.getByRole("button", { name: "Pause after this passage" }))
    expect(await screen.findByText("Finishing this passage…")).toBeInTheDocument()
    expect(transport.pause).toHaveBeenCalledWith(RUN)
  })

  it("shows a truthful finishing state from a server-published pausing frame", () => {
    applyRemoteFrame(frame("pausing", { done: 4, total: 12 }))
    render(<ContextualRunPill projectId="p1" fileId="file-1" canControl />)

    expect(screen.getByText("Finishing this passage…")).toBeInTheDocument()
    expect(screen.getByText("Autopilot will pause after the current passage.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Pause after this passage" })).not.toBeInTheDocument()
  })

  it("paused: resume and stop are distinct controls", () => {
    setContextualTransport(makeTransport())
    applyRemoteFrame(frame("paused", { done: 5, total: 10 }))
    render(<ContextualRunPill projectId="p1" fileId="file-1" canControl />)
    expect(screen.getByRole("button", { name: "Resume drafting" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Stop this run" })).toBeInTheDocument()
    expect(screen.getByText("Paused")).toBeInTheDocument()
  })

  it("parked: reports that no work is queued without claiming to watch source changes", () => {
    applyRemoteFrame(frame("parked", { done: 10, total: 10 }))
    render(<ContextualRunPill projectId="p1" fileId="file-1" canControl />)
    expect(screen.getByText("Idle · no work queued")).toBeInTheDocument()
    expect(screen.queryByText(/watching for changes/i)).not.toBeInTheDocument()
  })

  it("parked with an unfinished cursor reports queued work rather than false idle", () => {
    applyRemoteFrame(frame("parked", { done: 3, failed: 1, total: 10 }))
    render(<ContextualRunPill projectId="p1" fileId="file-1" canControl />)
    expect(screen.getByText("Queued · 6 passages remaining")).toBeInTheDocument()
    expect(screen.queryByText("Idle · no work queued")).not.toBeInTheDocument()
  })

  it("parked with failed passages and no remaining work reports complete with attention", () => {
    applyRemoteFrame(frame("parked", { done: 7, failed: 2, total: 9 }))
    render(<ContextualRunPill projectId="p1" fileId="file-1" canControl />)
    expect(screen.getByText("7/9 complete · 2 need attention")).toBeInTheDocument()
    expect(screen.queryByText("Idle · no work queued")).not.toBeInTheDocument()
  })

  it("done: reports completion and does not offer an invalid stop command", () => {
    applyRemoteFrame(frame("done", { done: 10, total: 10 }))
    render(<ContextualRunPill projectId="p1" fileId="file-1" canControl />)
    expect(screen.getByText("Complete")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Stop this run" })).not.toBeInTheDocument()
  })

  it("steer trigger: present while running and parked, absent when idle", () => {
    // Idle — no run, nothing to direct.
    const { unmount } = render(<ContextualRunPill projectId="p1" fileId="file-1" canControl />)
    expect(screen.queryByRole("button", { name: "Direct the run" })).not.toBeInTheDocument()
    unmount()

    setContextualTransport(makeTransport())
    applyRemoteFrame(frame("running", { done: 1, total: 10 }))
    const running = render(<ContextualRunPill projectId="p1" fileId="file-1" canControl />)
    expect(screen.getByRole("button", { name: "Direct the run" })).toBeInTheDocument()
    running.unmount()

    applyRemoteFrame(frame("parked", { done: 10, total: 10 }))
    render(<ContextualRunPill projectId="p1" fileId="file-1" canControl />)
    expect(screen.getByRole("button", { name: "Direct the run" })).toBeInTheDocument()
  })

  it("failed: red summary with dismiss", () => {
    applyRemoteFrame(frame("failed", { done: 6, total: 10, failed: 4 }))
    render(<ContextualRunPill projectId="p1" fileId="file-1" canControl />)
    expect(screen.getByText("4 of 10 passages had problems")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    // Back to the idle Play affordance.
    expect(screen.getByRole("button", { name: "Run Autopilot" })).toBeInTheDocument()
  })

  it("keeps preserved draft results visible when a partially successful run fails", () => {
    hydrateContextualDrafts(attachContextualDrafts("p1", "file-1", ""), [
      { draftId: "draft-1", cellId: "cell-1", text: "Draft one" },
      { draftId: "draft-2", cellId: "cell-2", text: "Draft two" },
    ])
    applyRemoteFrame(frame("failed", { done: 6, total: 10, failed: 4 }))

    render(<ContextualRunPill projectId="p1" fileId="file-1" canControl />)

    expect(screen.getByTestId("contextual-pending-drafts")).toHaveTextContent("2")
    expect(screen.getByRole("button", { name: "View Autopilot activity" })).toBeInTheDocument()
  })

  it("starts Autopilot on the editor's named target-language lane", async () => {
    const transport = makeTransport()
    setContextualTransport(transport)
    await act(async () => { await attachContextualRun("p1", "file-1", "fr") })
    render(<ContextualRunPill projectId="p1" fileId="file-1" activeLane="fr" canControl />)

    expect(screen.queryByText(/Project default only/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Run Autopilot" }))

    expect(transport.start).toHaveBeenCalledWith("p1", "file-1", undefined, "fr")
  })

  it("closes the default-run inspector when the editor switches to another language lane", async () => {
    applyRemoteFrame(frame("running", { done: 3, total: 12 }))
    const view = render(<ContextualRunPill projectId="p1" fileId="file-1" activeLane="" canControl />)
    fireEvent.click(screen.getByRole("button", { name: "View Autopilot activity" }))
    expect(screen.getByRole("dialog", { name: "Autopilot activity" })).toBeInTheDocument()

    view.rerender(<ContextualRunPill projectId="p1" fileId="file-1" activeLane="fr" canControl />)

    expect(screen.queryByRole("dialog", { name: "Autopilot activity" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Pause after this passage" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Run Autopilot" })).toBeInTheDocument()

    view.rerender(<ContextualRunPill projectId="p1" fileId="file-1" activeLane="" canControl />)
    expect(screen.queryByRole("dialog", { name: "Autopilot activity" })).not.toBeInTheDocument()
  })

  it("never renders or controls another open file's run", () => {
    const transport = makeTransport()
    setContextualTransport(transport)
    applyRemoteFrame(frame("running", { done: 3, total: 12 }))

    render(<ContextualRunPill projectId="p1" fileId="file-2" canControl />)

    expect(screen.queryByText("3/12")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Pause after this passage" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "View Autopilot activity" })).not.toBeInTheDocument()
    expect(transport.pause).not.toHaveBeenCalled()
  })

  it("keeps activity inspectable for viewers while hiding every server mutation", () => {
    setContextualTransport(makeTransport())
    applyRemoteFrame(frame("running", { done: 3, total: 12 }))
    const running = render(<ContextualRunPill projectId="p1" fileId="file-1" canControl={false} />)

    expect(screen.getByText("3/12")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Pause after this passage" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Direct the run" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "View Autopilot activity" }))
    expect(screen.getByRole("dialog", { name: "Autopilot activity" })).toHaveAttribute("data-can-control", "false")
    running.unmount()

    applyRemoteFrame(frame("paused", { done: 3, total: 12 }))
    render(<ContextualRunPill projectId="p1" fileId="file-1" canControl={false} />)
    expect(screen.queryByRole("button", { name: "Resume drafting" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Stop this run" })).not.toBeInTheDocument()
  })
})
