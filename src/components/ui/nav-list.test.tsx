import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"

import { BackLink, NavList, NavRow } from "./nav-list"

describe("NavRow hint", () => {
  it("hides the current value on small screens and shows it from sm up", () => {
    render(
      <MemoryRouter>
        <NavList label="Quality">
          <NavRow to="/settings/validation" title="Validation & health" hint="Reviewer" />
        </NavList>
      </MemoryRouter>,
    )

    expect(screen.getByText("Reviewer")).toHaveClass("hidden", "sm:block")
  })
})

describe("BackLink", () => {
  it("uses even horizontal padding so the hover chip is not start-heavy", () => {
    render(
      <MemoryRouter>
        <BackLink to="/settings" label="Project settings" />
      </MemoryRouter>,
    )

    const link = screen.getByRole("link", { name: "Project settings" })
    expect(link).toHaveClass("px-1.5")
    expect(link.className).not.toMatch(/\bps-4\b/)
    expect(link.className).not.toMatch(/\bpe-1\.5\b/)
  })
})
