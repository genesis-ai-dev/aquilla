// AQU-2260 (Sam, Oct 29): a hover may only NAME an icon-only button. Each rail
// button carries its own word ("Bibles", "Resources", "Who's Who"), so none of
// them has a hover.

import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ScriptureSideRail } from "./ScriptureSideRail"

describe("ScriptureSideRail", () => {
  it("has no hover on its buttons, and a click still switches panels", async () => {
    const onSelect = vi.fn()
    render(
      <TooltipProvider delay={0}>
        <ScriptureSideRail tabs={["bibles", "resources", "people"]} openPanel="bibles" onSelect={onSelect} />
      </TooltipProvider>,
    )
    for (const id of ["bibles-edge-tab", "resources-edge-tab", "whos-who-edge-tab"]) {
      await userEvent.setup().hover(screen.getByTestId(id))
      await act(() => new Promise((r) => setTimeout(r, 30)))
      expect(screen.queryByRole("tooltip")).toBeNull()
    }
    fireEvent.click(screen.getByTestId("resources-edge-tab"))
    expect(onSelect).toHaveBeenCalledWith("resources")
    fireEvent.click(screen.getByTestId("bibles-edge-tab"))
    expect(onSelect).toHaveBeenLastCalledWith(null)
  })
})
