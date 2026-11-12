import { expect, it, vi } from "vitest"
const state = vi.hoisted(() => ({ allowed: false, choose: vi.fn(async () => {}) }))
vi.mock("./analytics-account", () => ({ analyticsAccount: { eligible: () => state.allowed, choose: state.choose } }))
import { isAnalyticsEnabled, setAnalyticsEnabled } from "./analytics-consent"
it("uses account eligibility rather than an absent or legacy prechecked preference", async () => {
  for (const value of [null, "true", "false"]) {
    if (value === null) localStorage.removeItem("aquilla:analyticsEnabled")
    else localStorage.setItem("aquilla:analyticsEnabled", value)
    expect(isAnalyticsEnabled()).toBe(false)
  }
  await setAnalyticsEnabled(true)
  expect(state.choose).toHaveBeenCalledWith(true)
  expect(isAnalyticsEnabled()).toBe(false)
  state.allowed = true
  expect(isAnalyticsEnabled()).toBe(true)
  state.allowed = false
  expect(isAnalyticsEnabled()).toBe(false)
})
