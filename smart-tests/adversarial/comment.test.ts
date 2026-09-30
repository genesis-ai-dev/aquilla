import { describe, expect, it } from "vitest"
import { MARKER, renderComment } from "./comment"

const evidence = (verdict: string, extra: Record<string, unknown> = {}) => ({ "smart-testing-evidence": {
  outcome: { verdict, reason: `${verdict} reason`, checks: {}, diffs: [] }, projects: [],
  deployedBuild: { sha: "abc1234" }, ...extra } })
const canary = [
  { title: "canary: a scripted real edit passes the oracle", status: "passed", evidence: evidence("passed", { canary: true }) },
  { title: "canary: a planted wrong-row write is rejected", status: "passed", evidence: evidence("product_failure", { canary: true }) },
]
const attack = (id: string, verdict: string) =>
  ({ title: `adv condition ${id} #0`, status: verdict === "passed" ? "passed" : "failed", evidence: evidence(verdict, { attackId: id, mode: "condition" }) })
const base = { sha: "abc1234def", runUrl: "https://example.test/run" }

describe("PR comment", () => {
  it("carries the sticky marker so later runs update one comment", () => {
    expect(renderComment({ ...base, tests: [...canary, attack("a", "passed")] }).startsWith(MARKER)).toBe(true)
  })

  it("leads with failures and lists them first, so a reader sees what broke", () => {
    const text = renderComment({ ...base, tests: [...canary, attack("fine", "passed"), attack("broke", "product_failure")] })
    expect(text).toContain("**1 FAILURE FOUND.**")
    expect(text.indexOf("`broke`")).toBeLessThan(text.indexOf("`fine`"))
  })

  it("never claims a clean run when the canary failed", () => {
    const text = renderComment({ ...base, tests: [{ ...canary[0], status: "failed" }, canary[1], attack("a", "passed")] })
    expect(text).toContain("HARNESS UNAVAILABLE")
    expect(text).not.toContain("No failures found")
    expect(text).not.toContain("| `a` |")
  })

  it("is harness-unavailable when every attack was inconclusive", () => {
    expect(renderComment({ ...base, tests: [...canary, attack("a", "inconclusive")] })).toContain("HARNESS UNAVAILABLE")
  })

  it("refuses to vouch for a commit the preview did not serve", () => {
    expect(renderComment({ ...base, sha: "fff0000", tests: [...canary, attack("a", "passed")] })).toContain("NOT VERIFIED")
  })

  it("says NOT RUN when the suite never started", () => {
    const text = renderComment({ ...base, notRun: "The preview never served this commit." })
    expect(text).toContain("**NOT RUN.** The preview never served this commit.")
    expect(text).not.toContain("attacked")
  })

  it("shows the agent's stop reason, so a provider flake is not mistaken for an app miss", () => {
    const tests = [...canary, { ...attack("x", "inconclusive"), evidence: evidence("inconclusive", { attackId: "x",
      agents: [{ status: "driver_error", errors: [{ reason: "Text helper returned no valid field value; nothing typed." }] }, null] }) },
    attack("y", "passed")]
    expect(renderComment({ ...base, tests })).toContain("Agent: Text helper returned no valid field value")
  })

  it("escapes table-breaking characters in reasons", () => {
    const tests = [...canary, { ...attack("x", "product_failure"), evidence: evidence("product_failure", { attackId: "x", outcome: { verdict: "product_failure", reason: "a | b\nc", checks: {}, diffs: [] } }) }]
    expect(renderComment({ ...base, tests })).toContain("a \\| b c")
  })
})
