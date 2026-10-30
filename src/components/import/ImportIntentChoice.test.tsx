// AQU-2260 (Sam, Oct 29): nothing explains itself on hover. A greyed-out
// choice says why in one short line inside its own card, where it is seen.

import { describe, expect, it, vi } from "vitest"
import { act, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ImportIntentChoice } from "./ImportIntentChoice"

const REASON = "You're a Contributor; you need at least Project lead access."

function draw(sourceDisabledReason: string | null) {
  return render(
    <TooltipProvider delay={0}>
      <ImportIntentChoice
        value="translation"
        onChange={vi.fn()}
        sourceDisabledReason={sourceDisabledReason}
        translationDisabledReason={null}
      />
    </TooltipProvider>,
  )
}

describe("ImportIntentChoice — a greyed-out choice says why", () => {
  it("says why in its card, with no hover", async () => {
    draw(REASON)
    const card = screen.getByTestId("import-intent-source")
    expect(within(card).getByText(REASON)).toBeVisible()
    await userEvent.setup().hover(card)
    await act(() => new Promise((r) => setTimeout(r, 30)))
    expect(screen.queryByRole("tooltip")).toBeNull()
  })

  it("says nothing extra on a choice that is open", () => {
    draw(null)
    expect(screen.getByTestId("import-intent-source").querySelector('[data-slot="locked-note"]')).toBeNull()
  })
})
