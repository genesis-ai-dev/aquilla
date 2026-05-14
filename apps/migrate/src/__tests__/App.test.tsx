import { afterEach } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { describe, it, expect } from "vitest"
import { App } from "../App"

afterEach(() => {
  cleanup()
})

describe("migrate app placeholder", () => {
  it("renders the migrate landing", () => {
    render(<App />)
    expect(
      screen.getByRole("heading", { name: /legacy migration/i }),
    ).toBeTruthy()
  })

  it("disables the migration form inputs", () => {
    const { container } = render(<App />)
    const url = container.querySelector("#migrate-url") as HTMLInputElement | null
    const token = container.querySelector("#migrate-token") as HTMLInputElement | null
    const btn = screen.getByRole("button", { name: /start migration/i }) as HTMLButtonElement
    expect(url).toBeTruthy()
    expect(token).toBeTruthy()
    expect(url!.disabled).toBe(true)
    expect(token!.disabled).toBe(true)
    expect(btn.disabled).toBe(true)
  })
})
