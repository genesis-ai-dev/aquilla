import { expect, it, vi } from "vitest"

vi.unmock("@/lib/analytics-account")

it("does not revalidate or throw after the browser globals are torn down", async () => {
  const interval = vi.spyOn(window, "setInterval")
  const { analyticsAccount } = await import("./analytics-account")
  const tick = interval.mock.calls.find(([, delay]) => delay === 1_000)?.[0]
  expect(tick).toBeTypeOf("function")
  const revalidate = vi.spyOn(analyticsAccount, "revalidate")
  try {
    vi.stubGlobal("document", undefined)
    expect(() => (tick as () => void)()).not.toThrow()
    vi.unstubAllGlobals()
    vi.stubGlobal("navigator", undefined)
    expect(() => (tick as () => void)()).not.toThrow()
    expect(revalidate).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
    revalidate.mockRestore()
    interval.mockRestore()
  }
})
