// AQU-699: HelpMenu must advertise that it expands (chevron affordance) so the
// Tour housed inside it is discoverable, and the items under it must survive.
import { describe, it, expect } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { HelpMenu } from "./HelpMenu"

describe("HelpMenu", () => {
  it("renders a chevron affordance signalling the trigger expands", () => {
    const { container } = render(<HelpMenu />)
    const trigger = screen.getByRole("button", { name: /help & community/i })
    // The expand affordance is a lucide chevron rendered inside the trigger,
    // consistent with the sibling AccountSwitcher control.
    const chevron = container.querySelector(".lucide-chevron-down")
    expect(chevron).not.toBeNull()
    expect(trigger.contains(chevron)).toBe(true)
  })

  it("opens the menu and keeps the Tour reachable through it", async () => {
    render(<HelpMenu />)
    fireEvent.click(screen.getByRole("button", { name: /help & community/i }))
    // No regression to the items housed under the button.
    await waitFor(() => {
      expect(screen.getByText("Take the tour")).toBeInTheDocument()
    })
    expect(screen.getByText("Discord server")).toBeInTheDocument()
    expect(screen.getByText("Contact support")).toBeInTheDocument()
  })
})
