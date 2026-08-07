import { describe, expect, it, vi } from "vitest"
import { CHECK_LANES, runParallelChecks } from "./cloudflare-ci-checks.mjs"

const env = {
  WORKERS_CI: "1",
  WORKERS_CI_BRANCH: "feature/example",
  WORKERS_CI_COMMIT_SHA: "abcdef1234567890",
}

describe("Cloudflare parallel CI checks", () => {
  it("keeps every required check in an independent lane and omits unused browser installation", () => {
    expect(CHECK_LANES.map(({ name }) => name)).toEqual([
      "root",
      "identity",
      "sync",
      "release-contracts",
      "agent-worker",
      "spa",
    ])
    const commands = JSON.stringify(CHECK_LANES)
    expect(commands).toContain("lint")
    expect(commands).toContain("test:idml")
    expect(commands).toContain("neon:check")
    expect(commands).toContain("build:workers-build:identity")
    expect(commands).toContain("build:workers-build:sync")
    expect(commands).toContain("scripts/ci-build.sh")
    expect(commands).not.toContain("playwright")
  })

  it("starts all independent lanes before waiting for any one lane to finish", async () => {
    const started: string[] = []
    const releases = new Map<string, () => void>()
    const run = vi.fn((command: string, args: string[]) => new Promise<void>((resolve) => {
      const key = `${command} ${args.join(" ")}`
      started.push(key)
      releases.set(key, resolve)
    }))

    const promise = runParallelChecks({ env, run, log: vi.fn() })
    await vi.waitFor(() => expect(started).toHaveLength(CHECK_LANES.length))

    while (releases.size > 0) {
      const batch = [...releases.values()]
      releases.clear()
      batch.forEach((release) => release())
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await expect(promise).resolves.toBeUndefined()
  })

  it("fails closed and identifies every failed lane", async () => {
    const run = vi.fn(async (_command: string, args: string[]) => {
      if (args.includes("build:workers-build:sync")) throw new Error("sync failed")
    })

    await expect(runParallelChecks({ env, run, log: vi.fn() }))
      .rejects.toThrow("sync: sync failed")
  })
})
