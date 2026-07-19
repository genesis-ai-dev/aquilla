import { describe, it, expect, afterEach, vi } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import { Button } from "./button"

// AQU-594: buttons gained a `loading` state so an in-flight action reads as
// "processing" instead of static — testers reported "the system felt static
// even while processing tasks." Loading must (1) show a spinner, (2) mark the
// button aria-busy, and (3) disable it so the action can't be re-fired.
afterEach(() => cleanup())

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
    const btn = screen.getByRole("button", { name: /Import/ })
    expect(btn).toHaveAttribute("aria-busy", "true")
    expect(btn).toHaveAttribute("data-loading", "true")
    expect(btn.querySelector('[data-slot="button-spinner"]')).not.toBeNull()
  })

  it("disables the button and suppresses clicks while loading", () => {
    const onClick = vi.fn()
    render(
      <Button loading onClick={onClick}>
        Import
      </Button>
    )
    const btn = screen.getByRole("button", { name: /Import/ })
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })

  it("keeps an explicitly-disabled button disabled even when not loading", () => {
    render(
      <Button disabled loading={false}>
        Import
      </Button>
    )
    expect(screen.getByRole("button", { name: "Import" })).toBeDisabled()
  })
})
