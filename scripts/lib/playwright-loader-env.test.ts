import { describe, expect, it } from "vitest"
import { playwrightLoaderEnv, syncRegisterHooksCrashOnCircularCjs } from "./playwright-loader-env"

describe("playwright loader env", () => {
  it("forces the async loader on Node versions that crash loading jszip", () => {
    expect(syncRegisterHooksCrashOnCircularCjs("22.17.1")).toBe(true)
    expect(syncRegisterHooksCrashOnCircularCjs("22.15.0")).toBe(true)
    expect(syncRegisterHooksCrashOnCircularCjs("24.2.0")).toBe(true)
    expect(playwrightLoaderEnv("22.17.1")).toEqual({ PLAYWRIGHT_FORCE_ASYNC_LOADER: "1" })
  })

  it("leaves current Node on Playwright's sync loader", () => {
    expect(syncRegisterHooksCrashOnCircularCjs("22.18.0")).toBe(false)
    expect(syncRegisterHooksCrashOnCircularCjs("22.22.0")).toBe(false)
    expect(syncRegisterHooksCrashOnCircularCjs("24.3.0")).toBe(false)
    expect(syncRegisterHooksCrashOnCircularCjs("20.19.5")).toBe(false)
    expect(playwrightLoaderEnv("22.22.0")).toEqual({})
  })
})
