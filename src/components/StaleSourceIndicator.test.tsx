// AQU-477: second visual tone for inherited (ancestor-chain) staleness,
// distinct from the existing amber direct-stale badge (AQU-476/AD-9).

import { describe, it, expect } from "vitest"
import { render, screen } from "@testing-library/react"
import { StaleSourceIndicator } from "./StaleSourceIndicator"
import { expectClickNote } from "@/test-utils/tooltip"
import { vi } from "vitest"

describe("StaleSourceIndicator — managed mode", () => {
  it("renders nothing when the cell is in neither set", () => {
    render(
      <StaleSourceIndicator
        cellId="c1"
        staleCellIds={new Set()}
        upstreamStaleCellIds={new Set()}
      />,
    )
    expect(screen.queryByTestId("stale-source-indicator")).toBeNull()
    expect(screen.queryByTestId("upstream-stale-source-indicator")).toBeNull()
  })

  it("renders the amber direct-stale badge when the cell is in staleCellIds", () => {
    render(
      <StaleSourceIndicator
        cellId="c1"
        staleCellIds={new Set(["c1"])}
        upstreamStaleCellIds={new Set()}
      />,
    )
    expect(screen.getByTestId("stale-source-indicator")).toBeTruthy()
    expect(screen.queryByTestId("upstream-stale-source-indicator")).toBeNull()
  })

  it("renders the violet inherited-stale badge when the cell is ONLY in upstreamStaleCellIds", () => {
    render(
      <StaleSourceIndicator
        cellId="c1"
        staleCellIds={new Set()}
        upstreamStaleCellIds={new Set(["c1"])}
      />,
    )
    expect(screen.queryByTestId("stale-source-indicator")).toBeNull()
    const inherited = screen.getByTestId("upstream-stale-source-indicator")
    expect(inherited).toBeTruthy()
    expect(inherited.className).toContain("violet")
  })

  it("prioritizes the direct (amber) tone when a cell is in BOTH sets", () => {
    render(
      <StaleSourceIndicator
        cellId="c1"
        staleCellIds={new Set(["c1"])}
        upstreamStaleCellIds={new Set(["c1"])}
      />,
    )
    expect(screen.getByTestId("stale-source-indicator")).toBeTruthy()
    expect(screen.queryByTestId("upstream-stale-source-indicator")).toBeNull()
  })

  it("omitting upstreamStaleCellIds entirely still renders the direct badge (backward compatible)", () => {
    render(<StaleSourceIndicator cellId="c1" staleCellIds={new Set(["c1"])} />)
    expect(screen.getByTestId("stale-source-indicator")).toBeTruthy()
  })
})

// AQU-2260 (Sam, Oct 29): nothing explains itself on hover. The badge says
// what it means on a click of it, and the click goes no further.
describe("StaleSourceIndicator — the badge explains itself on a click", () => {
  it("the amber badge says the source changed", async () => {
    const onRow = vi.fn()
    render(
      <div onClick={onRow}>
        <StaleSourceIndicator cellId="c1" staleCellIds={new Set(["c1"])} upstreamStaleCellIds={new Set()} />
      </div>,
    )
    await expectClickNote(screen.getByTestId("stale-source-indicator"), "The source has changed since this translation was last revised.")
    expect(onRow).not.toHaveBeenCalled()
  })

  it("the violet badge says something upstream changed", async () => {
    render(<StaleSourceIndicator cellId="c1" staleCellIds={new Set()} upstreamStaleCellIds={new Set(["c1"])} />)
    await expectClickNote(screen.getByTestId("upstream-stale-source-indicator"), "further upstream in the translation chain")
  })
})
