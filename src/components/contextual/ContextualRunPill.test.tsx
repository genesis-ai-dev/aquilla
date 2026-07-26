import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import { ContextualRunPill } from "./ContextualRunPill"
import {
  applyRemoteFrame,
  resetContextualRunStore,
  setContextualTransport,
  type ContextualTransport,
} from "@/lib/contextual/run-store"

const RUN = "01920000-0000-7000-8000-000000000001"

function frame(status: "running" | "paused" | "parked" | "failed", patch: Partial<{ done: number; total: number; failed: number }> = {}) {
  return {
    type: "contextual.run.state" as const,
    runId: RUN,
    fileId: "file-1",
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

beforeEach(() => {
  cleanup()
  resetContextualRunStore()
})

describe("ContextualRunPill", () => {
  it("idle + backend unavailable: Play is clickable and opens setup (never disabled)", () => {
    const onSetupNeeded = vi.fn()
    render(<ContextualRunPill projectId="p1" fileId="file-1" onSetupNeeded={onSetupNeeded} />)
    const play = screen.getByRole("button", { name: "Contextual draft" })
    expect(play).not.toBeDisabled()
    fireEvent.click(play)
    expect(onSetupNeeded).toHaveBeenCalledTimes(1)
  })

  it("running: pause control, progress readout, span label click", () => {
    setContextualTransport(makeTransport())
    applyRemoteFrame(frame("running", { done: 3, total: 12 }))
    applyRemoteFrame({
      type: "contextual.scene", runId: RUN,
      sceneBriefId: "sb-1", spanLabel: "LUK 1:1–1:8", ambiguityCount: 1,
    })
    const onSpanClick = vi.fn()
    render(<ContextualRunPill projectId="p1" fileId="file-1" onSpanClick={onSpanClick} />)
    expect(screen.getByRole("button", { name: "Pause after this passage" })).toBeInTheDocument()
    expect(screen.getByText("3/12")).toBeInTheDocument()
    expect(screen.getByText(/Drafting…/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("LUK 1:1–1:8"))
    expect(onSpanClick).toHaveBeenCalledWith("LUK 1:1–1:8")
  })

  it("pause request shows the finishing message", async () => {
    const transport = makeTransport()
    setContextualTransport(transport)
    applyRemoteFrame(frame("running"))
    render(<ContextualRunPill projectId="p1" fileId="file-1" />)
    fireEvent.click(screen.getByRole("button", { name: "Pause after this passage" }))
    expect(await screen.findByText("Finishing this passage…")).toBeInTheDocument()
    expect(transport.pause).toHaveBeenCalledWith(RUN)
  })

  it("paused: resume and stop are distinct controls", () => {
    setContextualTransport(makeTransport())
    applyRemoteFrame(frame("paused", { done: 5, total: 10 }))
    render(<ContextualRunPill projectId="p1" fileId="file-1" />)
    expect(screen.getByRole("button", { name: "Resume drafting" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Stop this run" })).toBeInTheDocument()
    expect(screen.getByText("Paused")).toBeInTheDocument()
  })

  it("parked: watching for changes", () => {
    applyRemoteFrame(frame("parked", { done: 10, total: 10 }))
    render(<ContextualRunPill projectId="p1" fileId="file-1" />)
    expect(screen.getByText("Watching for changes")).toBeInTheDocument()
  })

  it("failed: red summary with dismiss", () => {
    applyRemoteFrame(frame("failed", { done: 6, total: 10, failed: 4 }))
    render(<ContextualRunPill projectId="p1" fileId="file-1" />)
    expect(screen.getByText("4 of 10 passages had problems")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
    // Back to the idle Play affordance.
    expect(screen.getByRole("button", { name: "Contextual draft" })).toBeInTheDocument()
  })
})
