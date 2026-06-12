// The pin pill must be honest about what context is actually sent: with no
// focused cell but an open file, file-level context still rides along on
// agent runs — "No cell context" misled the first real-model run's user
// (2026-06-12) into thinking the agent was blind to their file.

import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
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
})
