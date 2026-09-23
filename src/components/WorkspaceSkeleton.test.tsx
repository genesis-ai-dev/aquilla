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
    expect(status.querySelector("[data-slot='spinner']")).not.toBeNull()
  })
})
