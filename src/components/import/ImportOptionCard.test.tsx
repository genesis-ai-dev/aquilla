// AQU-2260 (Sam, Oct 29): nothing explains itself on hover. A greyed-out
// card says why in one short line inside the card, where it is seen.

import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Upload } from "lucide-react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ImportOptionCard } from "./ImportOptionCard"

const REASON = "Project lead or above required to link a source project."

describe("ImportOptionCard — a greyed-out card says why", () => {
  it("says why inside the card, with no hover, and a click chooses nothing", async () => {
    const onSelect = vi.fn()
    render(
      <TooltipProvider delay={0}>
        <ImportOptionCard
          icon={Upload} title="Link a project" description="Follow another project's source."
          onSelect={onSelect} disabled disabledTooltip={REASON} data-testid="card"
        />
      </TooltipProvider>,
    )
    const card = screen.getByTestId("card")
    expect(within(card).getByText(REASON)).toBeVisible()
    await userEvent.setup().hover(card)
    await act(() => new Promise((r) => setTimeout(r, 30)))
    expect(screen.queryByRole("tooltip")).toBeNull()
    fireEvent.click(card)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("an open card has no such line", () => {
    render(
      <ImportOptionCard icon={Upload} title="Upload" description="Files." onSelect={vi.fn()} data-testid="card" />,
    )
    expect(screen.getByTestId("card").querySelector('[data-slot="locked-note"]')).toBeNull()
  })
})
