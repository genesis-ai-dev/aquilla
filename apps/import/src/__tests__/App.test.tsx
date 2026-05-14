import { afterEach, describe, it, expect } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { App } from "../App"

afterEach(() => {
  cleanup()
})

describe("import app placeholder", () => {
  it("renders the import landing", () => {
    render(<App />)
    expect(
      screen.getByRole("heading", { name: /import source documents/i }),
    ).toBeTruthy()
  })

  it("disables the file picker", () => {
    const { container } = render(<App />)
    const input = container.querySelector(
      "#import-file-picker",
    ) as HTMLInputElement | null
    expect(input).toBeTruthy()
    expect(input!.disabled).toBe(true)
  })
})
