// The pin pill must be honest about what context is actually sent: with no
// focused cell but an open file, file-level context still rides along on
// agent runs — "No cell context" misled the first real-model run's user
// (2026-06-12) into thinking the agent was blind to their file.

import { describe, it, expect, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { ChatContextPin } from "./ChatContextPin"

describe("ChatContextPin", () => {
  it("shows the open file when no cell is focused but file context is on", () => {
    render(
      <ChatContextPin includeCellContext onToggle={() => {}} currentCell={null} fileName="Ruth" />,
    )
    expect(screen.getByText("File: Ruth")).toBeInTheDocument()
  })

  it("falls back to 'No cell context' when there is no cell and no file", () => {
    render(<ChatContextPin includeCellContext onToggle={() => {}} currentCell={null} />)
    expect(screen.getByText("No cell context")).toBeInTheDocument()
  })

  it("prefers the focused cell over the file name", () => {
    render(
      <ChatContextPin
        includeCellContext
        onToggle={() => {}}
        currentCell={{ context: "RUT 1:1", sourceText: "x", translatedText: "y" }}
        fileName="Ruth"
      />,
    )
    expect(screen.getByText("Cell: RUT 1:1")).toBeInTheDocument()
  })

  it("becomes a clearly named file picker in the agent workbench", () => {
    const onChooseContext = vi.fn()
    render(
      <ChatContextPin
        includeCellContext
        onToggle={() => {}}
        currentCell={null}
        onChooseContext={onChooseContext}
      />,
    )

    const button = screen.getByRole("button", { name: "Choose agent file" })
    expect(button).toHaveTextContent("Choose a file")
    fireEvent.click(button)
    expect(onChooseContext).toHaveBeenCalledOnce()
  })

  it("does not repeat the selected filename in the workbench picker", () => {
    render(
      <ChatContextPin
        includeCellContext
        onToggle={() => {}}
        currentCell={null}
        fileName="Ruth"
        onChooseContext={() => {}}
      />,
    )

    expect(screen.getByRole("button", { name: "Change agent file" })).toHaveTextContent("Change file")
    expect(screen.queryByText("Ruth")).not.toBeInTheDocument()
  })
})
