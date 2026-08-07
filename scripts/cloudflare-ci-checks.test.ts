import { describe, expect, it, vi } from "vitest"
import { CHECK_LANES, CHECK_PHASES, runParallelChecks } from "./cloudflare-ci-checks.mjs"

const env = {
  WORKERS_CI: "1",
  WORKERS_CI_BRANCH: "feature/example",
  WORKERS_CI_COMMIT_SHA: "abcdef1234567890",
}

describe("Cloudflare parallel CI checks", () => {
  it("keeps every required check in a bounded lane and installs the required browser", () => {
    expect(CHECK_LANES.map(({ name }) => name)).toEqual([
      "root",
      "sync",
      "agent-worker",
      "release-contracts",
      "identity",
      "spa",
    ])
    expect(CHECK_PHASES.map(({ lanes }) => lanes.map(({ name }) => name))).toEqual([
      ["root", "sync", "agent-worker"],
      ["release-contracts"],
      ["identity", "spa"],
    ])
    const commands = JSON.stringify(CHECK_LANES)
    expect(commands).toContain("lint")
    expect(commands).toContain("test:idml")
    expect(commands).toContain("neon:check")
    expect(commands).toContain("build:workers-build:identity")
    expect(commands).toContain("build:workers-build:sync")
    expect(commands).toContain("scripts/ci-build.sh")
    expect(commands).toContain("playwright")
    expect(commands).toContain("--with-deps")
    expect(commands).toContain("chromium")
  })

  it("runs independent lanes concurrently within bounded memory phases", async () => {
    const started: string[] = []
    const releases = new Map<string, () => void>()
    const run = vi.fn((command: string, args: string[]) => new Promise<void>((resolve) => {
      const key = `${command} ${args.join(" ")}`
      started.push(key)
      releases.set(key, resolve)
    }))

    const promise = runParallelChecks({ env, run, log: vi.fn() })
    await vi.waitFor(() => expect(started).toHaveLength(CHECK_PHASES[0].lanes.length))
    expect(started).not.toContain("pnpm run build:workers-build:identity")
    expect(started).not.toContain("bash scripts/ci-build.sh")

    while (started.length < CHECK_LANES.length || releases.size > 0) {
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
    expect(run.mock.calls.some(([, args]) => args.includes("build:workers-build:identity"))).toBe(false)
    expect(run.mock.calls.some(([, args]) => args.includes("scripts/ci-build.sh"))).toBe(false)
  })
})
