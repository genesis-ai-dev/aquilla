import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { AppTooltip, TooltipProvider } from "@/components/ui/tooltip"

describe("AppTooltip", () => {
  it("honors an immediate per-tooltip delay override", async () => {
    render(
      <TooltipProvider delay={600}>
        <AppTooltip content="Deadline details" delay={0}>
          <button type="button">Deadline status</button>
        </AppTooltip>
      </TooltipProvider>,
    )

    const trigger = screen.getByRole("button", { name: "Deadline status" })
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" })
    fireEvent.mouseEnter(trigger)

    await waitFor(() => {
      expect(screen.getByRole("tooltip")).toHaveTextContent("Deadline details")
    }, { timeout: 250 })
  })

  it("keeps the trigger mounted when disabled toggles (popover-anchor stability)", () => {
    const { rerender } = render(
      <TooltipProvider delay={0}>
        <AppTooltip content="Summary" disabled={false}>
          <button type="button" data-testid="anchor">Ring</button>
        </AppTooltip>
      </TooltipProvider>,
    )
    const before = screen.getByTestId("anchor")
    rerender(
      <TooltipProvider delay={0}>
        <AppTooltip content="Summary" disabled>
          <button type="button" data-testid="anchor">Ring</button>
        </AppTooltip>
      </TooltipProvider>,
    )
    // Early-returning children on disable remounted PopoverTriggers and flashed
    // anchored popovers at (0,0). disabled must pass through without remount.
    expect(screen.getByTestId("anchor")).toBe(before)
  })
})
