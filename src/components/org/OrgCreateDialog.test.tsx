import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { OrgCreateDialog } from "./OrgCreateDialog"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "anna", createdAt: "x" }, loading: false }),
}))
vi.mock("@/lib/frontier/orgs", () => ({
  createOrg: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/**
 * AQU-363 regression guard: the "Create organization" primary action (and the
 * whole footer) must stay inside the modal's bounds — it must not escape past
 * the modal's right/bottom edge. The dialog primitive keeps children contained
 * by clipping its own overflow; the footer bleeds to that clipped edge and
 * right-aligns its actions. This test pins that composition so the overflow
 * papercut can't silently regress.
 */
describe("OrgCreateDialog — footer stays within the modal (AQU-363)", () => {
  function open() {
    render(<OrgCreateDialog open onOpenChange={() => {}} onCreated={() => {}} />)
    const content = document.querySelector("[data-slot=dialog-content]") as HTMLElement | null
    expect(content).not.toBeNull()
    return content as HTMLElement
  }

  it("renders the footer and its actions inside the dialog content, not as escapees", () => {
    const content = open()
    const footer = content.querySelector("[data-slot=dialog-footer]") as HTMLElement | null
    // The footer must live *inside* the clipped content box — the original bug
    // was the action rendering outside the modal's padded content area.
    expect(footer).not.toBeNull()
    const createBtn = screen.getByRole("button", { name: /create organization/i })
    const cancelBtn = screen.getByRole("button", { name: /cancel/i })
    expect(footer!.contains(createBtn)).toBe(true)
    expect(footer!.contains(cancelBtn)).toBe(true)
  })

  it("clips its own overflow and is width-bounded so children can't spill past the edge", () => {
    const content = open()
    // The clip (`overflow-hidden`) + viewport-bounded width are the mechanism
    // that prevents any footer/button from overflowing the modal bounds.
    expect(content.className).toContain("overflow-hidden")
    expect(content.className).toContain("max-w-[calc(100%-2rem)]")
  })

  it("right-aligns footer actions in-bounds and shares the content's horizontal padding", () => {
    const content = open()
    const footer = content.querySelector("[data-slot=dialog-footer]") as HTMLElement
    // flex-end keeps actions pinned inside the right edge; the -mx-5/p-5 bleed
    // makes the footer's inner padding match the content body so the action
    // never sits wider than the modal's content column.
    expect(footer.className).toContain("sm:justify-end")
    expect(footer.className).toContain("-mx-5")
    expect(footer.className).toContain("p-5")
  })
})
