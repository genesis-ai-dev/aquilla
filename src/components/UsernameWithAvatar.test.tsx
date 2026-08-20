import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"

describe("UsernameWithAvatar", () => {
  it("uses the same two-letter initials as InitialsAvatar", () => {
    render(<UsernameWithAvatar username="ryder" />)
    expect(screen.getByText("RY")).toHaveAttribute("data-slot", "avatar-initials")
    expect(screen.getByText("ryder")).toBeInTheDocument()
  })
})
