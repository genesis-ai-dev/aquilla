import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Button } from "./button"

describe("Button press and open states", () => {
  it("keeps the outline border when a menu is open", () => {
    render(
      <Button variant="outline" aria-expanded="true">
        Filters
      </Button>,
    )
    const btn = screen.getByRole("button", { name: "Filters" })
    expect(btn.className).toMatch(/aria-expanded:border-border/)
    expect(btn.className).toMatch(/aria-expanded:bg-accent/)
  })

  it("transitions the press translate without easing color changes", () => {
    render(<Button>Save</Button>)
    const btn = screen.getByRole("button", { name: "Save" })
    expect(btn.className).toMatch(/\btransition-transform\b/)
    expect(btn.className).not.toMatch(/\btransition-(all|colors|none)\b/)
    expect(btn.className).toMatch(/active:not-aria-\[haspopup\]:translate-y-px/)
  })

  it("uses a stronger fill than hover for default, secondary, and ghost", () => {
    const { rerender } = render(<Button>Save</Button>)
    expect(screen.getByRole("button", { name: "Save" }).className).toMatch(
      /active:bg-\[color-mix\(in_oklch,var\(--primary\),var\(--foreground\)_10%\)\]/,
    )

    rerender(<Button variant="secondary">More</Button>)
    expect(screen.getByRole("button", { name: "More" }).className).toMatch(
      /active:bg-\[color-mix\(in_oklch,var\(--secondary\),var\(--foreground\)_7%\)\]/,
    )

    rerender(<Button variant="ghost">Menu</Button>)
    const ghost = screen.getByRole("button", { name: "Menu" })
    expect(ghost.className).toMatch(/hover:bg-muted/)
    expect(ghost.className).toMatch(/active:bg-accent/)
  })
})
