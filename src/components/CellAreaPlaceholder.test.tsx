import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { vi } from "vitest"

import { CellAreaPlaceholder, CellRowsLoadStatus } from "./CellAreaPlaceholder"

describe("CellAreaPlaceholder", () => {
  it("puts changing download progress inside the cloud-loading status and removes it on completion", () => {
    const retry = vi.fn()
    const { rerender } = render(<CellRowsLoadStatus loading error={false} progress={{ loaded: 52, total: 100 }} onRetryClick={retry} />)
    const status = screen.getByRole("status", { name: "Loading file from the cloud" })
    expect(status).toHaveTextContent("Loading file from the cloud… · 52%")
    expect(screen.getAllByRole("status")).toHaveLength(1)
    expect(screen.queryByText(/Loading cell data/)).not.toBeInTheDocument()
    rerender(<CellRowsLoadStatus loading error={false} progress={{ loaded: 99, total: 100 }} onRetryClick={retry} />)
    expect(status).toHaveTextContent("99%")
    rerender(<CellRowsLoadStatus loading={false} error={false} progress={{ loaded: 0, total: 100 }} onRetryClick={retry} />)
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("puts the percentage in the initial cloud-loading placeholder too", () => {
    render(<CellAreaPlaceholder state={{ kind: "syncing-empty" }} progress={{ loaded: 10, total: 20 }} />)
    expect(screen.getByRole("status", { name: "Loading file from the cloud" })).toHaveTextContent("Loading file from the cloud… · 50%")
  })

  it("keeps unresolved rows inert, supports retry, and disappears when complete", () => {
    const retry = vi.fn()
    const { rerender } = render(<CellRowsLoadStatus loading error={false} onRetryClick={retry} />)
    const status = screen.getByRole("status", { name: "Loading file from the cloud" })
    expect(status).toHaveAttribute("aria-busy", "true")
    expect(status.querySelector("[inert]")).not.toBeNull()
    expect(status.querySelectorAll("[data-slot='skeleton']")).toHaveLength(3)
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
    rerender(<CellRowsLoadStatus loading={false} error onRetryClick={retry} />)
    fireEvent.click(screen.getByRole("button", { name: "Retry loading file" }))
    expect(retry).toHaveBeenCalledOnce()
    rerender(<CellRowsLoadStatus loading={false} error={false} onRetryClick={retry} />)
    expect(screen.queryByTestId("cell-rows-load-status")).not.toBeInTheDocument()
  })

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
