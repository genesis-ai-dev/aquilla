import { describe, expect, it } from "vitest"
import { resolveTarget } from "./client"

const DEFAULTS = { authBase: "http://127.0.0.1:8788", syncBase: "http://127.0.0.1:8789" }
const HANDLE = { authBase: "https://api.dev.aquilla.app/identity", syncBase: "https://api.dev.aquilla.app/sync" }

describe("resolveTarget", () => {
  it("measures the stack the fixture was seeded against when the caller names nothing", () => {
    // The AQU-1868 bot-walk regression: a handle seeded elsewhere was measured
    // against localhost, so the report described a stack nobody asked about.
    expect(resolveTarget({}, HANDLE, DEFAULTS)).toEqual(HANDLE)
  })

  it("lets an explicit flag or env var override the handle", () => {
    expect(resolveTarget({ authBase: "http://localhost:9999" }, HANDLE, DEFAULTS)).toEqual({
      authBase: "http://localhost:9999",
      syncBase: HANDLE.syncBase,
    })
  })

  it("falls back to the local dev stack when neither the caller nor the handle says", () => {
    expect(resolveTarget({}, undefined, DEFAULTS)).toEqual(DEFAULTS)
    expect(resolveTarget({}, {}, DEFAULTS)).toEqual(DEFAULTS)
  })

  it("resolves each host independently", () => {
    expect(resolveTarget({ syncBase: "http://127.0.0.1:1234" }, { authBase: HANDLE.authBase }, DEFAULTS)).toEqual({
      authBase: HANDLE.authBase,
      syncBase: "http://127.0.0.1:1234",
    })
  })
})
