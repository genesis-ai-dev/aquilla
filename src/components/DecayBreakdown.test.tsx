import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { DecayBreakdown } from "./DecayBreakdown"
import { healthCardRows, type HealthCardCell } from "@/lib/health/health-card-rows"

// AQU-2278: the card's "Biggest drags" named lines by their raw cell id
// ("01a1…") whenever a line had no stored label, which is most lines.
const RUTH_ID = "01a1b2c3-0000-7000-8000-000000000004"

function openCard(cells: HealthCardCell[], health: Map<string, number>, order: string[]) {
  const onJumpToCell = vi.fn()
  const { container } = render(
    <DecayBreakdown
      health={40}
      scopeLabel="Project health"
      label="Project health: 40%"
      getHealthByCell={() => healthCardRows(cells, health, order, (index) => `row ${index}`)}
      onJumpToCell={onJumpToCell}
    >
      <span>ring</span>
    </DecayBreakdown>,
  )
  fireEvent.click(container.querySelector<HTMLElement>('[data-slot="popover-trigger"]')!)
  return onJumpToCell
}

describe("DecayBreakdown biggest drags", () => {
  it("names an unlabelled line by its reference, not its id, and opens it on click", async () => {
    const cells: HealthCardCell[] = [{ id: RUTH_ID, context: "RUT 1:4", globalReferences: ["RUT 1:4"] }]
    const onJumpToCell = openCard(cells, new Map([[RUTH_ID, 12]]), [RUTH_ID])

    const drag = await screen.findByRole("button", { name: /RUT 1:4.*12%/ })
    expect(screen.queryByText(RUTH_ID)).toBeNull()
    fireEvent.click(drag)
    expect(onJumpToCell).toHaveBeenCalledWith(RUTH_ID)
  })

  it("keeps a stored label first, and names a line with neither by its row", async () => {
    const cells: HealthCardCell[] = [
      { id: "labelled", cellLabel: "Opening", context: "RUT 1:1" },
      { id: "opaque", context: "3f2b8a10-1c2d-4e5f-8a9b-0c1d2e3f4a5b" },
    ]
    openCard(cells, new Map([["labelled", 5], ["opaque", 8]]), ["labelled", "opaque"])

    expect(await screen.findByRole("button", { name: /Opening.*5%/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: /row 2.*8%/ })).toBeTruthy()
    expect(screen.queryByText("opaque")).toBeNull()
  })
})
