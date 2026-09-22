import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { NavHistoryControls } from "./NavHistoryControls"
import type { NavHistoryValue } from "@/context/NavHistoryContext"

const nav: NavHistoryValue = {
  entries: [
    { key: "a", pathname: "/a", search: "", title: "Alpha", timestamp: 1 },
    { key: "b", pathname: "/b", search: "", title: "Beta", timestamp: 2 },
  ],
  index: 1,
  recent: [],
  canGoBack: true,
  canGoForward: false,
  goBack: vi.fn(),
  goForward: vi.fn(),
  go: vi.fn(),
  openRecent: vi.fn(),
  setCurrentTitle: vi.fn(),
}

vi.mock("@/context/NavHistoryContext", () => ({
  useNavHistory: () => nav,
}))

describe("NavHistoryControls", () => {
  it("groups the back and forward arrows, leaving previously viewed beside them", () => {
    render(<NavHistoryControls />)

    const back = screen.getByRole("button", { name: "Back to Alpha" })
    const forward = screen.getByRole("button", { name: "Forward" })
    const previouslyViewed = screen.getByRole("button", { name: "Previously viewed" })

    expect(back.closest("[data-slot=button-group]")).toBe(
      forward.closest("[data-slot=button-group]"),
    )
    expect(previouslyViewed.closest("[data-slot=button-group]")).toBeNull()
    expect(back).toHaveAttribute("data-variant", "ghost")
    expect(forward).toHaveAttribute("data-variant", "ghost")
    expect(previouslyViewed).toHaveAttribute("data-variant", "ghost")
  })

  it("stacks the clock above the arrows when orientation is vertical", () => {
    render(<NavHistoryControls orientation="vertical" />)

    const group = screen.getByRole("group", { name: "Page history" })
    expect(group).toHaveAttribute("data-orientation", "vertical")
    expect(group).toHaveClass("flex-col")

    const back = screen.getByRole("button", { name: "Back to Alpha" })
    const forward = screen.getByRole("button", { name: "Forward" })
    const arrowGroup = back.closest("[data-slot=button-group]")
    expect(arrowGroup).toHaveAttribute("data-orientation", "vertical")
    expect(arrowGroup).toContainElement(forward)
    expect(screen.getByRole("button", { name: "Previously viewed" })).toBeInTheDocument()
    fireEvent.click(back)
    expect(nav.goBack).toHaveBeenCalledTimes(1)
  })
})
