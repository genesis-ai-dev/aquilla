import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

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
      name: "Syncing file from the cloud",
    })
    expect(status).toHaveAttribute("aria-busy", "true")
    expect(within(status).getByText("Syncing file from the cloud…")).toBeInTheDocument()
    expect(status.querySelector("[data-slot='spinner']")).not.toBeNull()
    expect(status.querySelectorAll("[data-slot='skeleton']")).toHaveLength(32)
    expect(screen.queryByText(/0 cells/i)).not.toBeInTheDocument()
  })
})
