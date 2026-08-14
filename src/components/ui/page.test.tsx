import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Page, PageHeader, StatTile, STAT_TILE_GRID } from "./page"

describe("StatTile", () => {
  it("keeps multi-digit values compact without crowding adjacent numerals", () => {
    render(<StatTile label="Projects" value={388} />)

    const value = screen.getByText("388")
    expect(value).toHaveClass("tracking-normal", "tabular-nums")
    expect(value).not.toHaveClass("tracking-tight", "tracking-wide")
  })

  it("is a single horizontal row on the narrowest screens and a stacked tile from 480px", () => {
    const { container } = render(<StatTile label="Projects" value={3} />)
    const tile = container.firstElementChild
    expect(tile).toHaveClass("flex", "flex-row-reverse", "items-center", "justify-between", "min-h-[88px]")
    expect(tile).toHaveClass("min-[480px]:flex-col", "min-[480px]:items-start")
  })
})

describe("STAT_TILE_GRID", () => {
  it("steps from 1-up to 2-up at 480px, then 3-up, then 6-up", () => {
    expect(STAT_TILE_GRID).toContain("grid-cols-1")
    expect(STAT_TILE_GRID).toContain("min-[480px]:grid-cols-2")
    expect(STAT_TILE_GRID).toContain("md:grid-cols-3")
    expect(STAT_TILE_GRID).toContain("xl:grid-cols-6")
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

  it("pads the scroll shell so a max-width column never kisses the card", () => {
    const { container } = render(
      <Page>
        <div>body</div>
      </Page>,
    )
    expect(container.firstElementChild).toHaveClass("px-6")
  })

  it("reserves a stable scrollbar gutter so centered columns do not nudge", () => {
    const { container } = render(
      <Page>
        <div>body</div>
      </Page>,
    )
    expect(container.firstElementChild).toHaveClass(
      "overflow-y-auto",
      "scrollbar-gutter-stable",
    )
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
