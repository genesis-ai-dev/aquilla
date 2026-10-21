import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BuildFlowResult } from "../build-flow"

const runBuildFlow = vi.fn<(...args: unknown[]) => Promise<BuildFlowResult>>()
vi.mock("../build-flow", () => ({ runBuildFlow: (...args: unknown[]) => runBuildFlow(...args) }))

const jobs = await import("../build-jobs")

const manifest = { name: "Word Count", description: "", scopes: ["read:cells"], mounts: ["panel"], apiRev: 5 }
const ok = { ok: true, source: "<p>v1</p>", manifest, model: "m", attempts: 1, cost: 0.2, failures: [] } as unknown as BuildFlowResult

describe("build jobs (a build outlives the page)", () => {
  beforeEach(() => {
    runBuildFlow.mockReset()
    jobs.resetBuildJobs()
  })

  it("runs to a candidate and tells listeners whether anyone was watching", async () => {
    runBuildFlow.mockResolvedValue(ok)
    const seen: Array<[string, boolean]> = []
    const off = jobs.onBuildFinished((p) => seen.push([p, jobs.isWatched(p)]))
    const unwatch = jobs.watchBuilds("p1")
    unwatch() // the user left the page
    const run = jobs.startBuild("p1", "jwt", { words: "count words", request: "count words\n\n(mount: panel)" })
    expect(jobs.getBuildState("p1").job).toMatchObject({ status: "running", words: "count words" })
    await run
    expect(jobs.getBuildState("p1")).toMatchObject({ job: null, candidate: { request: "count words", origin: "builder", source: "<p>v1</p>" } })
    expect(seen).toEqual([["p1", false]])
    off()
  })

  it("keeps a failure until cleared", async () => {
    runBuildFlow.mockResolvedValue({ ok: false, failures: ["lint"], attempts: 3, cost: 0, model: null, source: null, manifest: null, requirements: [], review: null })
    await jobs.startBuild("p1", "jwt", { words: "x", request: "x" })
    expect(jobs.getBuildState("p1").job).toMatchObject({ status: "failed", failure: "lint" })
    jobs.clearJob("p1")
    expect(jobs.getBuildState("p1").job).toBeNull()
  })

  it("a cancelled build's late result is ignored", async () => {
    let finish: (r: BuildFlowResult) => void = () => {}
    runBuildFlow.mockReturnValue(new Promise((r) => { finish = r }))
    const run = jobs.startBuild("p1", "jwt", { words: "x", request: "x" })
    jobs.cancelBuild("p1")
    finish(ok)
    await run
    expect(jobs.getBuildState("p1")).toEqual({ job: null, candidate: null })
  })

  it("a change rebuilds from the current candidate and appends the words", async () => {
    runBuildFlow.mockResolvedValue(ok)
    jobs.setCandidate("p1", { request: "count words", source: "<p>v0</p>", manifest: manifest as never, origin: "builder" })
    await jobs.startBuild("p1", "jwt", { words: "add chapter totals", request: "add chapter totals", change: true })
    expect(runBuildFlow.mock.calls[0][2]).toEqual({ source: "<p>v0</p>", manifest })
    expect(jobs.getBuildState("p1").candidate?.request).toBe("count words\nadd chapter totals")
  })
})
