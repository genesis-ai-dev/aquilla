import { describe, expect, it } from "vitest"
import { harnessHealth, type Recorded } from "./health"

const verdict = (value: string): Recorded["evidence"] =>
  ({ outcome: { verdict: value, reason: "", checks: {} }, projects: [] })
const canaryOk: Recorded[] = [
  { project: "canary", status: "passed", evidence: verdict("passed") },
  { project: "canary", status: "passed", evidence: verdict("product_failure") },
]

describe("harness health", () => {
  it("is available when the canary passed and an attack reached a verdict", () => {
    expect(harnessHealth([...canaryOk, { project: "attacks", status: "failed", evidence: verdict("product_failure") }], 1).available).toBe(true)
  })

  it("is unavailable when the canary failed, so a broken oracle never speaks about the build", () => {
    const health = harnessHealth([{ ...canaryOk[0], status: "failed" }, canaryOk[1]], 1)
    expect(health).toEqual({ available: false, reason: "The canary health check failed (1 of 2)." })
  })

  it("is unavailable when every attack was inconclusive, the AQU-1350 shape", () => {
    expect(harnessHealth([...canaryOk, { project: "attacks", status: "skipped", evidence: verdict("inconclusive") }], 1).available).toBe(false)
  })

  it("is unavailable when attacks were planned but none ran", () => {
    expect(harnessHealth(canaryOk, 5).reason).toBe("No attack ran after the canary.")
  })

  it("is available for a canary-only run", () => {
    expect(harnessHealth(canaryOk, 0).available).toBe(true)
  })
})
