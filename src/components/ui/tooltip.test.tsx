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
})
