// AQU-1197 — an expanded accordion row must be visually contained.
//
// WHY these tests exist: the setup checklist is the app's one settings-style
// accordion — ChecklistItem rows and plain link rows share a SettingsGroup
// card. Expanded, a row's body used to be the same `bg-card` surface as the
// rows around it, so the only boundary between an open step's content and the
// next collapsed step was the list's own hairline divider: the eye could not
// parse where the open section ended. Opening now tints the row and draws a
// divider under its own header. Those classes ARE the fix, so they are what is
// asserted (AGENTS.md allows a class selector for a specific visual state).

import { describe, it, expect } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ChecklistItem } from "./ChecklistItem"

function renderItem() {
  const { container } = render(
    <ChecklistItem title="Import files" description="Bring in a source" complete={false}>
      <p>step body</p>
    </ChecklistItem>,
  )
  return {
    row: () => container.querySelector('[data-slot="collapsible"]'),
    trigger: () => screen.getByRole("button", { name: /Import files/ }),
  }
}

describe("ChecklistItem containment (AQU-1197)", () => {
  it("is an undecorated list row while collapsed", () => {
    const { row, trigger } = renderItem()
    expect(row()?.getAttribute("data-state")).toBe("closed")
    expect(row()?.className).not.toContain("bg-muted/30")
    expect(trigger().className).not.toContain("border-b")
    expect(screen.queryByText("step body")).not.toBeInTheDocument()
  })

  it("becomes a contained panel when expanded", () => {
    const { row, trigger } = renderItem()
    fireEvent.click(trigger())

    expect(row()?.getAttribute("data-state")).toBe("open")
    // A surface of its own, so the next collapsed row is visibly outside it…
    expect(row()?.className).toContain("bg-muted/30")
    // …and a divider between the step's header and its body.
    expect(trigger().className).toContain("border-b")
    expect(screen.getByText("step body")).toBeInTheDocument()
  })
})
