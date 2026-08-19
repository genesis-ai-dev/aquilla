import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
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
  })
})
