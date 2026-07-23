import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { WorkspaceSkeleton } from "./WorkspaceSkeleton"

describe("WorkspaceSkeleton", () => {
  it("shows a workspace-shaped template with one explicit loading status", () => {
    render(<WorkspaceSkeleton />)

    const status = screen.getByRole("status", { name: "Loading project" })
    expect(status).toHaveAttribute("aria-busy", "true")
    expect(screen.getByTestId("workspace-loading-template").parentElement).toHaveAttribute("inert")
    expect(screen.getByText("Loading project…")).toBeInTheDocument()
    expect(status.querySelector("[data-slot='spinner']")).not.toBeNull()
  })
})
