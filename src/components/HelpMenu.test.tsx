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
    const tour = screen.getByRole("menuitem", { name: /take the tour/i })
    expect(tour.className).toMatch(/focus:bg-accent\/40/)
    const homepage = screen.getByRole("menuitem", { name: /homepage/i })
    // Tour leads the menu so the expand affordance points at the primary action.
    expect(tour.compareDocumentPosition(homepage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(homepage).toHaveAttribute("href", "/homepage")
    expect(homepage).toHaveAttribute("target", "_blank")
    expect(homepage).toHaveAttribute("rel", "noopener noreferrer")
    expect(screen.getByText("Discord server")).toBeInTheDocument()
    expect(screen.getByText("Contact support")).toBeInTheDocument()
    // AQU-1548: the item that opens the report dialog is labelled "Feedback"
    // and sits last. It is a rename of the old "Report" item, not a second
    // entry beside it, so "Report" must be gone rather than duplicated.
    const feedback = screen.getByRole("menuitem", { name: /feedback/i })
    expect(screen.queryByText("Report")).not.toBeInTheDocument()
    const support = screen.getByRole("menuitem", { name: /contact support/i })
    expect(
      support.compareDocumentPosition(feedback) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  // AQU-1548: with the shell's labelled button gone, this item is the only way
  // a stuck user reaches the dialog — so the menu must close and the dialog
  // must actually open, not merely be wired up.
  it("opens the feedback dialog from the Feedback item", async () => {
    renderHelpMenu()
    fireEvent.click(screen.getByRole("button", { name: /help & community/i }))
    fireEvent.click(await screen.findByRole("menuitem", { name: /feedback/i }))
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/what went wrong/i)).toBeInTheDocument()
    })
    // The dialog's own contents (screenshot affordance, submit, confirmation)
    // are ReportProblemDialog.test.tsx's business; what this pins is that the
    // menu hands off to it and closes behind itself.
    expect(screen.getByRole("button", { name: /send report/i })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: /feedback/i })).not.toBeInTheDocument()
  })

  it("opens the compact question-mark menu start-aligned", async () => {
    render(
      <MemoryRouter>
        <HelpMenu compact />
      </MemoryRouter>,
    )
    fireEvent.click(screen.getByRole("button", { name: /help & community/i }))
    const homepage = await screen.findByRole("menuitem", { name: /homepage/i })
    expect(homepage.closest("[data-side]")).toHaveAttribute("data-side", "top")
    expect(homepage.closest("[data-align]")).toHaveAttribute("data-align", "start")
  })
})
