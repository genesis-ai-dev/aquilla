// AQU-1197 — an expanded settings section must be visually contained.
//
// WHY these tests exist: this is the one expand-in-place section in Project
// Settings. It used to be a bare `rounded-lg border p-3` box whose open body
// continued straight on from its summary row, with no divider and no surface
// change, so there was nothing to tell the eye where the expanded section
// ended. The classes asserted below ARE the fix (AGENTS.md allows a class
// selector for verifying a specific visual state), and the control test pins
// that re-shaping the markup did not break the settings it holds.

import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { I18nProvider } from "@/lib/i18n/I18nProvider"
import { DecaySettingsSection } from "./DecaySettingsSection"

function renderSection(onChange = vi.fn()) {
  const { container } = render(
    <I18nProvider>
      <DecaySettingsSection settings={{ maxHops: 4 }} onChange={onChange} />
    </I18nProvider>,
  )
  const disclosure = container.querySelector('[data-slot="settings-disclosure"]')
  const body = container.querySelector('[data-slot="settings-disclosure-body"]')
  return { disclosure, body, onChange }
}

describe("DecaySettingsSection containment (AQU-1197)", () => {
  it("is a settings card, not a bare outline on the page background", () => {
    const { disclosure } = renderSection()
    expect(disclosure).not.toBeNull()
    for (const cls of ["rounded-lg", "border", "bg-card"]) {
      expect(disclosure?.classList.contains(cls)).toBe(true)
    }
  })

  it("separates the expanded body from the summary row and gives it its own surface", () => {
    const { disclosure, body } = renderSection()

    // The divider only draws once the section is open, so a collapsed card
    // stays a single clean row.
    const summary = disclosure?.querySelector("summary")
    expect(summary?.className).toContain("group-open:border-b")

    expect(body).not.toBeNull()
    expect(body?.className).toContain("bg-muted/30")
    // The body is the summary's sibling inside the card — the contained panel,
    // not a continuation of the row above it.
    expect(body?.parentElement).toBe(disclosure)
  })

  it("still edits the decay tunables through onChange", () => {
    const { onChange } = renderSection()
    fireEvent.change(screen.getByLabelText("Max hops"), {
      target: { value: "6" },
    })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ maxHops: 6 }))
  })
})
