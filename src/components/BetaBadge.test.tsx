import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe("BetaBadge", () => {
  it("uses a native button for the dialog trigger without Base UI errors", async () => {
    vi.stubEnv("VITE_BETA_FLAG", "1")
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { BetaBadge } = await import("./BetaBadge")

    render(<BetaBadge />)

    expect(screen.getByRole("button", { name: "Beta" }).tagName).toBe("BUTTON")
    expect(error).not.toHaveBeenCalled()
  })
})
