import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { InitialsAvatar } from "@/components/InitialsAvatar"

describe("InitialsAvatar", () => {
  it("pins initials color inline so menu **:text-* cannot recolor the glyph", () => {
    render(<InitialsAvatar name="alice" menuSafe />)
    const initials = screen.getByText("AL")
    expect(initials).toHaveAttribute("data-slot", "avatar-initials")
    expect(initials).toHaveStyle({ color: "#ffffff" })
  })

  it("pins white inline on colored fallbacks even without menuSafe", () => {
    render(<InitialsAvatar name="bob" />)
    expect(screen.getByText("BO")).toHaveStyle({ color: "#ffffff" })
  })

  it("honors menuSafeColor on the initials node", () => {
    render(
      <InitialsAvatar name="carol" menuSafe menuSafeColor="var(--muted-foreground)" />,
    )
    expect(screen.getByText("CA").getAttribute("style")).toContain(
      "color: var(--muted-foreground)",
    )
  })
})
