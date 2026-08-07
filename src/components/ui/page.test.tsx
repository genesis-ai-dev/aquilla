import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Page, PageHeader, StatTile } from "./page"

describe("StatTile", () => {
  it("keeps multi-digit values compact without crowding adjacent numerals", () => {
    render(<StatTile label="Projects" value={388} />)

    const value = screen.getByText("388")
    expect(value).toHaveClass("tracking-normal", "tabular-nums")
    expect(value).not.toHaveClass("tracking-tight", "tracking-wide")
  })
})

describe("Page", () => {
  it("keeps the generous vertical page pad", () => {
    const { container } = render(
      <Page>
        <div>body</div>
      </Page>,
    )
    const well = container.firstElementChild?.firstElementChild
    expect(well).toHaveClass("py-18")
  })
})

describe("PageHeader", () => {
  it("insets the title by default so settings pages align with card text", () => {
    const { container } = render(<PageHeader title="Organization settings" />)
    expect(container.firstElementChild).toHaveClass("pl-4")
  })

  it("skips inset padding on table / list surfaces", () => {
    const { container } = render(<PageHeader title="Teams" inset={false} />)
    expect(container.firstElementChild).not.toHaveClass("pl-4")
  })

  it("keeps the section-stack gap below the title", () => {
    const { container } = render(<PageHeader title="All organizations" />)
    expect(container.firstElementChild).toHaveClass("mb-12")
  })
})
