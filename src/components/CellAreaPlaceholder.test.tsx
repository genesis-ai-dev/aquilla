import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { vi } from "vitest"

import { CellAreaPlaceholder } from "./CellAreaPlaceholder"

describe("CellAreaPlaceholder", () => {
  it("keeps the editor-shaped template and shows explicit progress while cells hydrate", () => {
    render(
      <CellAreaPlaceholder
        state={{ kind: "syncing-empty" }}
        fileName="GEN"
        hasFiles
        filesLoaded
      />,
    )

    const status = screen.getByRole("status", {
      name: "Loading file from the cloud",
    })
    expect(status).toHaveAttribute("aria-busy", "true")
    expect(within(status).getByText("Loading file from the cloud…")).toBeInTheDocument()
    expect(status.querySelector("[data-slot='spinner']")).not.toBeNull()
    expect(status.querySelectorAll("[data-slot='skeleton']")).toHaveLength(32)
    expect(screen.queryByText(/0 cells/i)).not.toBeInTheDocument()
  })

  // AQU-819: a plain read is loading, not syncing. "Syncing" is reserved for
  // edits actually being flushed to the server (the outbox indicator).
  it("never calls the initial file read 'syncing'", () => {
    render(
      <CellAreaPlaceholder
        state={{ kind: "syncing-empty" }}
        fileName="GEN"
        hasFiles
        filesLoaded
      />,
    )

    expect(screen.queryByText(/sync/i)).not.toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveAccessibleName(/^Loading\b/)
  })

  it("shows a recoverable load error instead of claiming the file is empty", () => {
    const retry = vi.fn()
    render(
      <CellAreaPlaceholder
        state={{ kind: "load-error" }}
        fileName="sample.md"
        hasFiles
        filesLoaded
        onRetryClick={retry}
      />,
    )

    expect(screen.getByText("Couldn't load sample.md")).toBeInTheDocument()
    expect(screen.queryByText(/sample\.md is empty/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Retry loading file" }))
    expect(retry).toHaveBeenCalledOnce()
  })
})
