import { describe, expect, it } from "vitest"
import { createNoopTelemetry, type TelemetryClient } from "./index"

describe("@aquilla/telemetry", () => {
  it("createNoopTelemetry returns a TelemetryClient that no-ops every method", () => {
    const client = createNoopTelemetry()
    // None of these should throw.
    client.identify("u1")
    client.identify("u1", { plan: "free" })
    client.capture("test_event")
    client.capture("test_event", { foo: "bar" })
    client.setSuperProperty("env", "test")
    client.optIn()
    client.optOut()
  })

  it("flush resolves without throwing", async () => {
    const client = createNoopTelemetry()
    await expect(client.flush()).resolves.toBeUndefined()
    await expect(client.flush(100)).resolves.toBeUndefined()
  })

  it("type smoke: TelemetryClient interface is implementable", () => {
    const custom: TelemetryClient = {
      identify: () => {},
      capture: () => {},
      setSuperProperty: () => {},
      optIn: () => {},
      optOut: () => {},
      flush: async () => {},
    }
    custom.capture("anything")
    expect(typeof custom.capture).toBe("function")
  })
})
