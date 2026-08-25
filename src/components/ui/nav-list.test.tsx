import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"

import { NavList, NavRow } from "./nav-list"

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
