// AQU-699: HelpMenu must advertise that it expands (chevron affordance) so the
// Tour housed inside it is discoverable, and the items under it must survive.
import { describe, it, expect } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { HelpMenu } from "./HelpMenu"

// The menu now houses ReportProblemDialog, which reads the current route to
// attach it to a report, so the trigger needs router context to mount.
const renderHelpMenu = () =>
  render(
    <MemoryRouter>
      <HelpMenu />
    </MemoryRouter>,
  )

describe("HelpMenu", () => {
  it("renders a chevron affordance signalling the trigger expands", () => {
    const { container } = renderHelpMenu()
    const trigger = screen.getByRole("button", { name: /help & community/i })
    // The expand affordance is a lucide chevron rendered inside the trigger,
    // consistent with the sibling AccountSwitcher control.
    const chevron = container.querySelector(".lucide-chevron-down")
    expect(chevron).not.toBeNull()
    expect(trigger.contains(chevron)).toBe(true)
  })

  it("hides Take the tour when showTour is false", async () => {
    render(
      <MemoryRouter>
        <HelpMenu showTour={false} />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole("button", { name: /help & community/i }))
    await waitFor(() => {
      expect(screen.getByText("Discord server")).toBeInTheDocument()
    })
    expect(screen.queryByText("Take the tour")).not.toBeInTheDocument()
  })

  it("opens the menu and keeps the Tour reachable through it", async () => {
    renderHelpMenu()
    fireEvent.click(screen.getByRole("button", { name: /help & community/i }))
    // No regression to the items housed under the button.
    await waitFor(() => {
      expect(screen.getByText("Take the tour")).toBeInTheDocument()
    })
    const homepage = screen.getByRole("menuitem", { name: /homepage/i })
    expect(homepage).toHaveAttribute("href", "/homepage")
    expect(homepage).toHaveAttribute("target", "_blank")
    expect(homepage).toHaveAttribute("rel", "noopener noreferrer")
    expect(screen.getByText("Discord server")).toBeInTheDocument()
    expect(screen.getByText("Contact support")).toBeInTheDocument()
    // Report moved out of its own dock button and into this menu.
    expect(screen.getByText("Report")).toBeInTheDocument()
  })
})
