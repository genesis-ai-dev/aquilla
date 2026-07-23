import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { StatTile } from "./page"

describe("StatTile", () => {
  it("keeps multi-digit values compact without crowding adjacent numerals", () => {
    render(<StatTile label="Projects" value={388} />)

    const value = screen.getByText("388")
    expect(value).toHaveClass("tracking-normal", "tabular-nums")
    expect(value).not.toHaveClass("tracking-tight", "tracking-wide")
  })
})
