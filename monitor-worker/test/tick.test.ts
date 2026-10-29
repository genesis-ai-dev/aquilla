import { describe, expect, it, vi } from "vitest"
import type { MonitorConfig } from "../src/config"
import { applyResults, type TargetState } from "../src/state"
import { runTick, type TickDeps } from "../src/tick"

const config: MonitorConfig = {
  environment: "production",
  targets: [{ id: "sync", name: "Sync API", url: "https://api.test/sync/health" }],
  failureThreshold: 1,
  recoveryThreshold: 1,
  reminderMinutes: 60,
  mentionRoleIds: ["123456789012345678"],
  mentionUserIds: [],
}

/** An in-memory stand-in for the Durable Object plus a scripted fetch. */
function harness(targetStatus: number, overrides: Partial<TickDeps> = {}) {
  let stored: Record<string, TargetState> = {}
  const calls: string[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.startsWith("https://api.test")) return new Response("ok", { status: targetStatus })
    return new Response(null, { status: 204 })
  })
  const deps: TickDeps = {
    fetch: fetchImpl as unknown as typeof fetch,
    now: () => 1_000,
    record: async (results, thresholds, now) => {
      const outcome = applyResults(stored, results, thresholds, now)
      stored = outcome.states
      return outcome
    },
    discordWebhookUrl: "https://discord.test/hook",
    heartbeatUrl: "https://heartbeat.test/ping",
    ...overrides,
  }
  return { deps, calls }
}

describe("runTick", () => {
  it("sends nothing to Discord when all is well, and pings the heartbeat", async () => {
    const { deps, calls } = harness(200)
    expect(await runTick(config, deps)).toEqual([])
    expect(calls).toEqual(["https://api.test/sync/health", "https://heartbeat.test/ping"])
  })

  it("alerts Discord on an outage, then pings the heartbeat", async () => {
    const { deps, calls } = harness(503)
    const events = await runTick(config, deps)
    expect(events.map((e) => e.kind)).toEqual(["down"])
    expect(calls).toEqual(["https://api.test/sync/health", "https://discord.test/hook", "https://heartbeat.test/ping"])
  })

  it("fails the run and skips the heartbeat when an alert cannot be sent", async () => {
    const { deps, calls } = harness(503, { discordWebhookUrl: undefined })
    await expect(runTick(config, deps)).rejects.toThrow(/DISCORD_WEBHOOK_URL is not set/)
    expect(calls).not.toContain("https://heartbeat.test/ping")
  })

  it("does not alert twice for the same outage", async () => {
    const { deps } = harness(503)
    expect(await runTick(config, deps)).toHaveLength(1)
    expect(await runTick(config, deps)).toHaveLength(0)
  })
})
