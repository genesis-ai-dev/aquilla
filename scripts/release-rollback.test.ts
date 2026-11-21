import { describe, expect, it } from "vitest"
import { activeVersion, decideRollback, rollbackPlan, workerVerdict } from "./release-rollback.mjs"

// The watch changes production by itself, in both directions: a missed
// signal leaves a broken release up, a false one takes a good release down.
// Each row is a count pair and what the watch must make of it.
describe("workerVerdict", () => {
  it.each([
    ["a clean release", { requests: 9000, errors: 9 }, { requests: 1500, errors: 2 }, "ok"],
    ["a release that throws on a tenth of requests", { requests: 9000, errors: 9 }, { requests: 1500, errors: 150 }, "bad"],
    ["a rise that stays under the floor", { requests: 9000, errors: 9 }, { requests: 1500, errors: 60 }, "ok"],
    ["a Worker that was already failing as often", { requests: 9000, errors: 900 }, { requests: 1500, errors: 180 }, "ok"],
    ["an already failing Worker that got three times worse", { requests: 9000, errors: 900 }, { requests: 1500, errors: 480 }, "bad"],
    ["too little traffic to say, however bad it looks", { requests: 9000, errors: 9 }, { requests: 40, errors: 40 }, "quiet"],
    ["no baseline at all", null, { requests: 1500, errors: 150 }, "bad"],
    ["analytics that would not answer", { requests: 9000, errors: 9 }, null, "no-signal"],
  ])("%s", (_name, before, after, verdict) => {
    expect(workerVerdict({ before, after }).verdict).toBe(verdict)
  })

  it("says the numbers it decided on", () => {
    expect(workerVerdict({ before: { requests: 9000, errors: 9 }, after: { requests: 1500, errors: 150 } }).why).toBe(
      "150 of 1500 invocations failed (10.0%); the hour before: 0.1%; limit 5.0%",
    )
  })
})

describe("decideRollback", () => {
  const ok = (worker: string) => ({ worker, verdict: "ok" as const, why: "fine" })

  it("rolls the whole release back when one Worker is bad, and names it", () => {
    const decision = decideRollback({ workers: [ok("aquilla-web"), { worker: "aquilla-sync-worker", verdict: "bad", why: "150 of 1500" }], probe: { ok: true } })
    expect(decision).toEqual({ action: "rollback", reason: "aquilla-sync-worker: 150 of 1500" })
  })

  it("rolls back on a failed live check even when every rate is fine", () => {
    expect(decideRollback({ workers: [ok("aquilla-web")], probe: { ok: false, why: "identity /health answered 503" } }).action).toBe("rollback")
  })

  it("never reads a blind watch as a clean one", () => {
    const blind = { worker: "aquilla-identity", verdict: "no-signal" as const, why: "analytics returned nothing" }
    expect(decideRollback({ workers: [ok("aquilla-web"), blind], probe: { ok: true } }).action).toBe("no-signal")
  })

  it("leaves a quiet or clean release alone", () => {
    expect(decideRollback({ workers: [ok("aquilla-web"), { worker: "aquilla-identity", verdict: "quiet", why: "12 invocations" }], probe: { ok: true } }).action).toBe("none")
  })
})

describe("what a rollback promotes", () => {
  const snapshot = {
    surfaces: [
      { surface: "web", worker: "aquilla-web", directory: "/repo", versionId: "web-old" },
      { surface: "sync", worker: "aquilla-sync-worker", directory: "/repo/sync-worker", versionId: "sync-old" },
      // A Worker that was mid-rollout at snapshot time has no single version to go back to.
      { surface: "identity", worker: "aquilla-identity", directory: "/repo/auth-worker", versionId: null },
    ],
  }

  it("is every surface that moved off its recorded version, and no surface with nothing recorded", () => {
    expect(rollbackPlan(snapshot, { web: "web-new", sync: "sync-old", identity: "id-new" })).toEqual([
      { surface: "web", worker: "aquilla-web", directory: "/repo", versionId: "web-old" },
    ])
  })

  it("reads the serving version only from one version at 100%", () => {
    expect(activeVersion({ versions: [{ version_id: "v1", percentage: 100 }] })).toBe("v1")
    expect(activeVersion({ versions: [{ version_id: "v1", percentage: 50 }, { version_id: "v2", percentage: 50 }] })).toBeNull()
    expect(activeVersion({})).toBeNull()
  })
})
