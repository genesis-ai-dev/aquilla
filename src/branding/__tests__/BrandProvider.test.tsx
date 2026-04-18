import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, act, cleanup } from "@testing-library/react"
import { BrandProvider } from "../BrandProvider"
import { useBrand } from "../use-brand"

function Probe() {
  const brand = useBrand()
  return <div data-testid="name">{brand.app.name}</div>
}

describe("BrandProvider / useBrand", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/")
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllEnvs()
  })

  it("exposes the brand passed in", () => {
    vi.stubEnv("DEV", false)
    vi.stubEnv("VITE_BRAND", "honeycomb")
    render(
      <BrandProvider>
        <Probe />
      </BrandProvider>,
    )
    expect(screen.getByTestId("name").textContent).toBe("Honeycomb Studio")
  })

  it("re-renders when ?brand= changes in dev mode", async () => {
    vi.stubEnv("DEV", true)
    vi.stubEnv("VITE_BRAND", "codex")
    render(
      <BrandProvider>
        <Probe />
      </BrandProvider>,
    )
    expect(screen.getByTestId("name").textContent).toBe("Codex Translator")
    act(() => {
      window.history.pushState({}, "", "/?brand=context")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    expect(screen.getByTestId("name").textContent).toBe("Context Studio")
  })

  it("throws when useBrand is called outside a provider", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(() => render(<Probe />)).toThrow(/BrandProvider/)
    err.mockRestore()
  })
})
