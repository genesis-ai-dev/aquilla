import { describe, expect, it } from "vitest"
import { agentNeverActed, harnessHealth, type Recorded } from "./health"

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

describe("agentNeverActed", () => {
  const agent = (reason: string) => ({ errors: [{ reason }] })

  it("reports the driver's own words when the text helper typed nothing, the AQU-1513 shape", () => {
    const reason = "Text helper returned no valid field value; nothing typed."
    expect(agentNeverActed([agent(reason), null])).toBe(reason)
  })

  it("reports every closed-set driver message that says no input reached the page", () => {
    for (const reason of [
      "Invalid TypeSafe response; no action executed.",
      "Model connection failed; no action executed.",
      "Model provider returned HTTP 503; no action executed.",
      "Driver stopped without executing an unverified action",
    ]) expect(agentNeverActed([agent(reason)])).toBe(reason)
  })

  it("is silent when the agents acted, so a real finding still reaches the product", () => {
    expect(agentNeverActed([{ errors: [{ reason: "Loading state did not settle" }] }, null])).toBe(null)
    expect(agentNeverActed([{ errors: [] }, null])).toBe(null)
    expect(agentNeverActed([null, null])).toBe(null)
    expect(agentNeverActed(undefined)).toBe(null)
  })
})
