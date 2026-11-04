import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { WorkspaceMainSkeleton } from "./WorkspaceSkeleton"

describe("WorkspaceMainSkeleton", () => {
  it("shows a cell-table template with one explicit loading status", () => {
    render(<WorkspaceMainSkeleton />)

    const status = screen.getByRole("status", { name: "Loading project" })
    expect(status).toHaveAttribute("aria-busy", "true")
    expect(screen.getByTestId("workspace-loading-template").parentElement).toHaveAttribute("inert")
    expect(screen.getByText("Loading project…")).toBeInTheDocument()
    // One cursor, which prints the label: no separate pill.
    expect(status.querySelectorAll("[data-slot='loading-cursor']")).toHaveLength(1)
  })
})
