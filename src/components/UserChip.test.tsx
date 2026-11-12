import { describe, expect, it } from "vitest"
import { screen } from "@testing-library/react"
import { UserChip } from "@/components/UserChip"
import { expectTooltip, renderWithTooltips } from "@/test-utils/tooltip"

describe("UserChip", () => {
  it("shows the username and keeps the user id in the tooltip", async () => {
    renderWithTooltips(<UserChip userId={77} username="priya" />)
    expect(screen.getByText("PR")).toHaveAttribute("data-slot", "avatar-initials")
    const name = screen.getByText("priya")
    expect(name).toHaveAttribute("data-slot", "username")
    expect(name.textContent).not.toContain("77")
    await expectTooltip(screen.getByText("priya").closest("[data-slot=user-chip]")!, "User ID 77")
  })

  it("says User, with a stable shape, when there is no username", async () => {
    const { rerender } = renderWithTooltips(<UserChip userId={77} username={null} />)
    expect(screen.getByText("User")).toBeInTheDocument()
    expect(screen.queryByText("77")).not.toBeInTheDocument()
    const mark = document.querySelector("[data-slot=user-chip-shape]")
    expect(mark).not.toBeNull()
    const shape = mark?.getAttribute("data-shape")
    rerender(<UserChip userId={77} username="" />)
    expect(document.querySelector("[data-slot=user-chip-shape]")?.getAttribute("data-shape")).toBe(shape)
    rerender(<UserChip userId={88} username={null} />)
    expect(screen.getAllByText("User")).toHaveLength(1)
  })

  it("does not invent a name for a placeholder username", () => {
    renderWithTooltips(<UserChip userId="4" username="local" distinguishId="conn-9" />)
    expect(screen.getByText("User")).toBeInTheDocument()
    expect(screen.queryByText(/comet|river|drifting/i)).not.toBeInTheDocument()
  })

  it("puts the name in the tooltip when only the mark is shown", async () => {
    renderWithTooltips(<UserChip userId={3} username="anna" avatarOnly hint="Contributor" />)
    const chip = document.querySelector("[data-slot=user-chip]")!
    expect(chip).toHaveAttribute("aria-label", "anna")
    expect(screen.queryByText("anna")).not.toBeInTheDocument()
    await expectTooltip(chip, "User ID 3")
    await expectTooltip(chip, "Contributor")
  })
})
