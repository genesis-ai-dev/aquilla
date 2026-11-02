// AQU-2260 (Sam, Oct 29): the lock beside a locked Living Memory section says
// who may edit on a click, never on hover (hover does nothing on touch).
import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import { renderWithTooltips, expectClickNote } from "@/test-utils/tooltip"
import { RoleLockTooltip } from "./AuthoredEntriesSection"

describe("RoleLockTooltip", () => {
  it("says which role may edit, on click", async () => {
    renderWithTooltips(<RoleLockTooltip reason="role" />)
    await expectClickNote(
      screen.getByRole("button", { name: "Editing requires the Maintainer role or above." }),
      "Editing requires the Maintainer role or above.",
    )
  })

  it("names the lower floor a style rule really needs", async () => {
    renderWithTooltips(<RoleLockTooltip reason="role" requiredRole="contributor" />)
    await expectClickNote(
      screen.getByRole("button", { name: "This requires the Contributor role or above." }),
      "This requires the Contributor role or above.",
    )
  })

  it("says the section is offline, on click", async () => {
    renderWithTooltips(<RoleLockTooltip reason="offline" />)
    await expectClickNote(screen.getByRole("button", { name: "You are offline. Reconnect to edit." }), "Reconnect to edit")
  })

  it("draws nothing when nothing is locked", () => {
    const { container } = render(<RoleLockTooltip reason={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})
