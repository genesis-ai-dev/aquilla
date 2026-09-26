import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { Button } from "./button"

afterEach(() => cleanup())

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
    expect(ghost.className).toMatch(/hover:bg-accent\/40/)
    expect(ghost.className).toMatch(/active:bg-accent/)

    rerender(<Button variant="outline">Filters</Button>)
    const outline = screen.getByRole("button", { name: "Filters" })
    expect(outline.className).toMatch(/hover:bg-accent\/40/)
    expect(outline.className).toMatch(/active:bg-accent/)
  })
})

// AQU-594: buttons gained a `loading` state so an in-flight action reads as
// "processing" instead of static — testers reported "the system felt static
// even while processing tasks." Loading must (1) show a spinner, (2) mark the
// button aria-busy, and (3) disable it so the action can't be re-fired.
describe("Button loading state (AQU-594)", () => {
  it("renders label without spinner or busy state when idle", () => {
    render(<Button>Import</Button>)
    const btn = screen.getByRole("button", { name: "Import" })
    expect(btn).not.toHaveAttribute("aria-busy")
    expect(btn.querySelector('[data-slot="button-spinner"]')).toBeNull()
    expect(btn).not.toBeDisabled()
  })

  it("shows a spinner and marks the button busy while loading", () => {
    render(<Button loading>Import</Button>)
    const btn = screen.getByRole("button", { name: "Import" })
    expect(btn).toHaveAttribute("aria-busy", "true")
    expect(btn).toHaveAttribute("data-loading", "true")
    expect(btn.querySelector('[data-slot="button-spinner"]')).not.toBeNull()
  })

  it("disables the button and suppresses clicks while loading", () => {
    const onClick = vi.fn()
    render(
      <Button loading onClick={onClick}>
        Import
      </Button>,
    )
    const btn = screen.getByRole("button", { name: "Import" })
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })

  it("keeps an explicitly-disabled button disabled even when not loading", () => {
    render(
      <Button disabled loading={false}>
        Import
      </Button>,
    )
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled()
  })
})
