/**
 * AQU-1468: when a read/draft fails because the file is ambiguous, the run
 * shows each candidate as a button named by its exact file name. Only the
 * newest run's buttons work, and never while a run is streaming.
 */

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import type { AgentRunUi } from "@/lib/agent/run-state"
import { AgentRunView } from "./AgentRunView"

function makeRun(overrides: Partial<AgentRunUi> = {}): AgentRunUi {
  return {
    localId: "run-local-1",
    prompt: "Draft practice1",
    runId: "run-1",
    status: "ok",
    items: [
      {
        id: "i0",
        kind: "tool",
        step: 1,
        tool: "read",
        summary: "practice · all",
        ok: false,
        resultSummary: "error: matches more than one file",
        data: {
          candidates: [
            { id: "f1", name: "Practice_Notes" },
            { id: "f2", name: "Practice1_Come_Before_God_Today" },
            { id: "f1", name: "Practice_Notes" },
          ],
        },
      },
      { id: "i1", kind: "text", text: "Which file do you mean?" },
    ],
    ...overrides,
  }
}

describe("file candidate buttons", () => {
  it("renders one button per file, labelled with the exact name, without expanding the chip", () => {
    render(<AgentRunView run={makeRun()} onChooseFile={vi.fn()} fileChoiceEnabled />)
    expect(screen.getByText("Choose a file:")).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: /^Practice/ })).toHaveLength(2)
    expect(screen.getByRole("button", { name: "Practice_Notes" })).toBeEnabled()
    expect(screen.getByRole("button", { name: "Practice1_Come_Before_God_Today" })).toBeEnabled()
  })

  it("calls the callback with the clicked file, and works from the keyboard's click", () => {
    const onChooseFile = vi.fn()
    render(<AgentRunView run={makeRun()} onChooseFile={onChooseFile} fileChoiceEnabled />)
    fireEvent.click(screen.getByRole("button", { name: "Practice1_Come_Before_God_Today" }))
    expect(onChooseFile).toHaveBeenCalledWith({ id: "f2", name: "Practice1_Come_Before_God_Today" })
  })

  it("disables the buttons on an old run and never calls back", () => {
    const onChooseFile = vi.fn()
    render(<AgentRunView run={makeRun()} onChooseFile={onChooseFile} fileChoiceEnabled={false} />)
    const button = screen.getByRole("button", { name: "Practice_Notes" })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onChooseFile).not.toHaveBeenCalled()
  })

  it("disables the buttons while the run is streaming", () => {
    render(<AgentRunView run={makeRun({ status: "running" })} onChooseFile={vi.fn()} fileChoiceEnabled />)
    expect(screen.getByRole("button", { name: "Practice_Notes" })).toBeDisabled()
  })

  it("shows no buttons for a successful tool step or without a handler", () => {
    const ok = makeRun()
    if (ok.items[0].kind === "tool") ok.items[0] = { ...ok.items[0], ok: true }
    const { rerender } = render(<AgentRunView run={ok} onChooseFile={vi.fn()} fileChoiceEnabled />)
    expect(screen.queryByText("Choose a file:")).not.toBeInTheDocument()
    rerender(<AgentRunView run={makeRun()} />)
    expect(screen.queryByText("Choose a file:")).not.toBeInTheDocument()
  })

  it("shows no buttons once a later tool step ran in the same run", () => {
    const run = makeRun()
    run.items.push({ id: "i2", kind: "tool", step: 2, tool: "draft", summary: "MRK 1", ok: true })
    render(<AgentRunView run={run} onChooseFile={vi.fn()} fileChoiceEnabled />)
    expect(screen.queryByText("Choose a file:")).not.toBeInTheDocument()
  })
})
