import { afterEach, describe, it, expect } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { App } from "../App"

afterEach(() => {
  cleanup()
})

describe("export app placeholder", () => {
  it("renders the export landing", () => {
    render(<App />)
    expect(
      screen.getByRole("heading", { name: /export translations/i }),
    ).toBeTruthy()
  })

  it("disables every export button", () => {
    render(<App />)
    const buttons = screen.getAllByRole("button", { name: /export as/i })
    expect(buttons.length).toBeGreaterThan(0)
    for (const b of buttons) {
      expect((b as HTMLButtonElement).disabled).toBe(true)
    }
  })
})
