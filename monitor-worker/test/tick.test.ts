import { describe, expect, it, vi } from "vitest"
import type { MonitorConfig } from "../src/config"
import { applyResults, type TargetState } from "../src/state"
import {
  evaluateStuckSessions,
  initialStuckSessionsState,
  type StuckSessionsState,
} from "../src/stuck-sessions"
import { runTick, type TickDeps } from "../src/tick"

const config: MonitorConfig = {
  environment: "production",
  targets: [{ id: "sync", name: "Sync API", url: "https://api.test/sync/health" }],
  stuckSessions: null,
  failureThreshold: 1,
  recoveryThreshold: 1,
  reminderMinutes: 60,
  mentionRoleIds: ["123456789012345678"],
  mentionUserIds: [],
}

/** An in-memory stand-in for the Durable Object plus a scripted fetch. */
function harness(
  targetStatus: number,
  overrides: Partial<TickDeps> = {},
  stuckBody: unknown = { ok: true, n: 0 },
) {
  let stored: Record<string, TargetState> = {}
  let stuckState: StuckSessionsState = initialStuckSessionsState(0)
  const calls: string[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes("/admin/db/stuck-sessions")) {
      return new Response(JSON.stringify(stuckBody), { status: 200 })
    }
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
    recordStuckSessions: async (reading, now) => {
      const out = evaluateStuckSessions(stuckState, reading, { threshold: 5, repeatMinutes: 10 }, now)
      stuckState = out.next
      return { state: out.next, alert: out.alert }
    },
    discordWebhookUrl: "https://discord.test/hook",
    heartbeatUrl: "https://heartbeat.test/ping",
    ...overrides,
  }
  return { deps, calls }
}

const STUCK_CONFIG: MonitorConfig = {
  ...config,
  stuckSessions: {
    url: "https://api.test/sync/admin/db/stuck-sessions",
    threshold: 5,
    repeatMinutes: 10,
    timeoutMs: 10_000,
  },
}

describe("runTick", () => {
  it("sends nothing to Discord when all is well, and pings the heartbeat", async () => {
    const { deps, calls } = harness(200)
    expect(await runTick(config, deps)).toEqual({ events: [], stuckSessions: undefined })
    expect(calls).toEqual(["https://api.test/sync/health", "https://heartbeat.test/ping"])
  })

  it("alerts Discord on an outage, then pings the heartbeat", async () => {
    const { deps, calls } = harness(503)
    const { events } = await runTick(config, deps)
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
    expect((await runTick(config, deps)).events).toHaveLength(1)
    expect((await runTick(config, deps)).events).toHaveLength(0)
  })
})

// AQU-2611 — the database check rides the same tick as the uptime targets.
describe("runTick — stuck database sessions", () => {
  it("does not probe the database at all when the check is unconfigured", async () => {
    const { deps, calls } = harness(200)
    await runTick(config, deps)
    expect(calls.some((c) => c.includes("stuck-sessions"))).toBe(false)
  })

  it("probes and stays quiet on a healthy database", async () => {
    const { deps, calls } = harness(200, { syncAdminToken: "s3cret" })
    const outcome = await runTick(STUCK_CONFIG, deps)
    expect(outcome.stuckSessions).toBeUndefined()
    expect(calls).toContain("https://api.test/sync/admin/db/stuck-sessions")
    expect(calls).not.toContain("https://discord.test/hook")
  })

  it("posts a Discord alert carrying the count and the statement", async () => {
    const { deps, calls } = harness(200, { syncAdminToken: "s3cret" }, {
      ok: true,
      n: 55,
      backendsAnyApplication: 55,
      sampleQuery: "select settings from organizations where id = $1",
    })
    const outcome = await runTick(STUCK_CONFIG, deps)
    expect(outcome.stuckSessions).toMatchObject({ kind: "stuck", count: 55 })
    expect(calls).toContain("https://discord.test/hook")
    const body = JSON.parse(
      String((deps.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
        .find((c: unknown[]) => String(c[0]) === "https://discord.test/hook")![1].body),
    )
    expect(JSON.stringify(body)).toContain("55")
    expect(JSON.stringify(body)).toContain("select settings from organizations where id = $1")
  })

  it("fails the run and skips the heartbeat when the probe cannot be read", async () => {
    const { deps, calls } = harness(200, {
      syncAdminToken: "s3cret",
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes("stuck-sessions")) return new Response("nope", { status: 503 })
        if (url.startsWith("https://api.test")) return new Response("ok", { status: 200 })
        return new Response(null, { status: 204 })
      }) as unknown as typeof fetch,
    })
    await expect(runTick(STUCK_CONFIG, deps)).rejects.toThrow(/stuck-session probe failed/)
    expect(calls).not.toContain("https://heartbeat.test/ping")
  })

  it("fails the run when the probe URL is configured without a bearer — after the uptime alerts go out", async () => {
    const { deps, calls } = harness(503, { syncAdminToken: undefined })
    await expect(runTick(STUCK_CONFIG, deps)).rejects.toThrow(/SYNC_ADMIN_TOKEN is not/)
    // The outage still had to be reported; only the heartbeat is withheld.
    expect(calls).toContain("https://discord.test/hook")
    expect(calls).not.toContain("https://heartbeat.test/ping")
  })
})
