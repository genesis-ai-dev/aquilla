import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { DiscoveredFormsChips } from "./DiscoveredFormsChips"
import { I18nProvider } from "@/lib/i18n/I18nProvider"

const forms = [
  { surface: "וְהָאָ֗רֶץ", count: 3, excluded: false, sampleCellIds: [] },
  { surface: "הָאָֽרֶץ", count: 1, excluded: true, sampleCellIds: [] },
]

describe("DiscoveredFormsChips", () => {
  // WHY: the chip is the only affordance for exclusion; clicking must report
  // the surface and the NEW excluded state, and excluded chips must be
  // visibly distinct so users can tell what is off.
  it("renders counts and toggles exclusion", () => {
    const onToggle = vi.fn()
    render(
      <I18nProvider>
        <DiscoveredFormsChips forms={forms} onToggleExclude={onToggle} />
      </I18nProvider>,
    )
    fireEvent.click(screen.getByRole("button", { name: /Exclude וְהָאָ֗רֶץ/ }))
    expect(onToggle).toHaveBeenCalledWith("וְהָאָ֗רֶץ", true)
    fireEvent.click(screen.getByRole("button", { name: /Include הָאָֽרֶץ/ }))
    expect(onToggle).toHaveBeenCalledWith("הָאָֽרֶץ", false)
    expect(screen.getByText("3")).toBeTruthy()
  })
})
