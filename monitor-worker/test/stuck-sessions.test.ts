// AQU-2611 — the threshold and the throttle on the "sessions stuck half-sent"
// alert, plus the probe's reading of sync-worker's admin route.
//
// These are the two decisions the ticket is about: fire at the threshold (no
// three-tick ramp — a healthy database has zero such sessions, so waiting is
// pure delay), repeat at most once per 10 minutes while it holds, and post a
// recovery line exactly once when it clears.
import { describe, expect, it, vi } from "vitest"
import {
  DEFAULT_REPEAT_MINUTES,
  DEFAULT_THRESHOLD,
  evaluateStuckSessions,
  initialStuckSessionsState,
  probeStuckSessions,
  stuckSessionsEmbed,
  type StuckSessionsConfig,
  type StuckSessionsReading,
  type StuckSessionsState,
} from "../src/stuck-sessions"

const CONFIG: StuckSessionsConfig = {
  url: "https://api.test/sync/admin/db/stuck-sessions",
  threshold: DEFAULT_THRESHOLD,
  repeatMinutes: DEFAULT_REPEAT_MINUTES,
  timeoutMs: 10_000,
}

const MINUTE = 60_000
const reading = (count: number, sampleQuery?: string): StuckSessionsReading => ({
  ok: true,
  count,
  sampleQuery,
})

/** Feeds readings minute by minute and collects what was alerted when. */
function run(counts: (number | StuckSessionsReading)[], start = 10 * MINUTE) {
  let state: StuckSessionsState = initialStuckSessionsState(start)
  const alerts: { at: number; kind: string; count: number; repeat: boolean }[] = []
  counts.forEach((entry, index) => {
    const now = start + (index + 1) * MINUTE
    const next = evaluateStuckSessions(
      state,
      typeof entry === "number" ? reading(entry) : entry,
      CONFIG,
      now,
    )
    state = next.next
    if (next.alert) {
      alerts.push({
        at: (now - start) / MINUTE,
        kind: next.alert.kind,
        count: next.alert.count,
        repeat: next.alert.repeat,
      })
    }
  })
  return { state, alerts }
}

describe("evaluateStuckSessions — threshold", () => {
  it("says nothing while the count is under the threshold", () => {
    const { alerts, state } = run([0, 1, 4, 4, 0])
    expect(alerts).toEqual([])
    expect(state.alerting).toBe(false)
  })

  it("alerts on the first reading at the threshold — no ramp", () => {
    const { alerts } = run([DEFAULT_THRESHOLD])
    expect(alerts).toEqual([{ at: 1, kind: "stuck", count: 5, repeat: false }])
  })

  it("alerts above the threshold and reports the observed count", () => {
    const { alerts } = run([55])
    expect(alerts[0]).toMatchObject({ kind: "stuck", count: 55 })
  })

  it("honours a configured threshold other than the default", () => {
    const strict = { threshold: 2, repeatMinutes: 10 }
    const first = evaluateStuckSessions(initialStuckSessionsState(0), reading(2), strict, MINUTE)
    expect(first.alert?.kind).toBe("stuck")
    const lenient = { threshold: 50, repeatMinutes: 10 }
    expect(evaluateStuckSessions(initialStuckSessionsState(0), reading(2), lenient, MINUTE).alert)
      .toBeUndefined()
  })

  it("carries the stuck statement's leading text on the alert", () => {
    const sql = "select id, settings from organizations where id = $1"
    const { alerts: _ } = run([0])
    const out = evaluateStuckSessions(
      initialStuckSessionsState(0),
      reading(9, sql),
      CONFIG,
      MINUTE,
    )
    expect(out.alert?.sampleQuery).toBe(sql)
  })
})

describe("evaluateStuckSessions — throttle", () => {
  it("does not repeat inside the 10-minute window", () => {
    // Stuck for nine consecutive minutes: one alert, not nine.
    const { alerts } = run(Array(9).fill(7))
    expect(alerts).toEqual([{ at: 1, kind: "stuck", count: 7, repeat: false }])
  })

  it("repeats once the window has elapsed, flagged as a repeat", () => {
    const { alerts } = run(Array(22).fill(7))
    expect(alerts.map((a) => [a.at, a.kind, a.repeat])).toEqual([
      [1, "stuck", false],
      [11, "stuck", true],
      [21, "stuck", true],
    ])
  })

  it("never repeats when repeatMinutes is 0", () => {
    let state = initialStuckSessionsState(0)
    const alerts: string[] = []
    for (let minute = 1; minute <= 30; minute++) {
      const out = evaluateStuckSessions(state, reading(7), { threshold: 5, repeatMinutes: 0 }, minute * MINUTE)
      state = out.next
      if (out.alert) alerts.push(out.alert.kind)
    }
    expect(alerts).toEqual(["stuck"])
  })

  it("posts one recovery line when it clears, and stays quiet after", () => {
    const { alerts } = run([7, 7, 0, 0, 0])
    expect(alerts.map((a) => a.kind)).toEqual(["stuck", "cleared"])
    expect(alerts[1]).toMatchObject({ at: 3, count: 0 })
  })

  it("reports the peak count and the episode's start on the recovery line", () => {
    let state = initialStuckSessionsState(0)
    let last
    for (const [index, count] of [6, 40, 12, 0].entries()) {
      last = evaluateStuckSessions(state, reading(count), CONFIG, (index + 1) * MINUTE)
      state = last.next
    }
    expect(last!.alert).toMatchObject({ kind: "cleared", peakCount: 40, since: MINUTE })
  })

  it("alerts again for a fresh episode after a recovery, without waiting", () => {
    const { alerts } = run([7, 0, 7])
    expect(alerts.map((a) => [a.at, a.kind, a.repeat])).toEqual([
      [1, "stuck", false],
      [2, "cleared", false],
      [3, "stuck", false],
    ])
  })

  it("holds state on an unreadable probe instead of reporting a false recovery", () => {
    const { alerts, state } = run([
      7,
      { ok: false, count: 0, error: "probe answered HTTP 503" },
      { ok: false, count: 0, error: "probe answered HTTP 503" },
    ])
    expect(alerts.map((a) => a.kind)).toEqual(["stuck"])
    expect(state.alerting).toBe(true)
  })
})

describe("probeStuckSessions", () => {
  const fetchReturning = (status: number, body?: unknown) =>
    vi.fn(async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch

  it("reads the count, the unfiltered total and the sample query", async () => {
    const fetchImpl = fetchReturning(200, {
      ok: true,
      n: 55,
      backendsAnyApplication: 55,
      sampleQuery: "select 1 from organizations where id = $1",
      minAgeSeconds: 30,
    })
    expect(await probeStuckSessions(CONFIG, "s3cret", fetchImpl)).toEqual({
      ok: true,
      count: 55,
      countAnyApplication: 55,
      sampleQuery: "select 1 from organizations where id = $1",
    })
  })

  it("sends the admin bearer", async () => {
    let seen: Record<string, string> | undefined
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.headers as Record<string, string> | undefined
      return new Response(JSON.stringify({ n: 0 }), { status: 200 })
    })
    await probeStuckSessions(CONFIG, "s3cret", fetchImpl as unknown as typeof fetch)
    expect(seen?.Authorization).toBe("Bearer s3cret")
  })

  it("reports not-ok (never zero) when the probe is refused", async () => {
    const out = await probeStuckSessions(CONFIG, "wrong", fetchReturning(401))
    expect(out).toMatchObject({ ok: false, error: "probe answered HTTP 401" })
  })

  it("reports not-ok when the body carries no count", async () => {
    const out = await probeStuckSessions(CONFIG, "s3cret", fetchReturning(200, { ok: true }))
    expect(out).toMatchObject({ ok: false, error: "probe answered without a count" })
  })

  it("reports not-ok when the probe cannot be reached", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connection refused")
    }) as unknown as typeof fetch
    expect(await probeStuckSessions(CONFIG, "s3cret", fetchImpl)).toMatchObject({
      ok: false,
      error: "connection refused",
    })
  })
})

describe("stuckSessionsEmbed", () => {
  it("puts the count and the statement text in the alert", () => {
    const embed = stuckSessionsEmbed(
      {
        kind: "stuck",
        at: 60 * MINUTE,
        since: 59 * MINUTE,
        count: 55,
        peakCount: 55,
        sampleQuery: "select settings from organizations where id = $1",
        repeat: false,
      },
      CONFIG,
    )
    expect(embed.title).toContain("55 database sessions stuck half-sent")
    const values = embed.fields.map((f) => f.value).join("\n")
    expect(values).toContain("55")
    expect(values).toContain("select settings from organizations where id = $1")
  })

  it("marks a repeat differently from the first alert", () => {
    const base = { at: 70 * MINUTE, since: 59 * MINUTE, count: 9, peakCount: 12 } as const
    expect(stuckSessionsEmbed({ kind: "stuck", ...base, repeat: true }, CONFIG).title)
      .toContain("STILL stuck")
  })

  it("keeps statement text inert — no backticks escaping the code fence", () => {
    const embed = stuckSessionsEmbed(
      {
        kind: "stuck",
        at: MINUTE,
        since: MINUTE,
        count: 5,
        peakCount: 5,
        sampleQuery: "select `a` -- @everyone",
        repeat: false,
      },
      CONFIG,
    )
    const field = embed.fields.find((f) => f.name === "Stuck statement")!
    expect(field.value).not.toContain("select `a`")
    expect(field.value).toContain("select 'a' -- @everyone")
  })

  it("reports the peak and the duration on the recovery line", () => {
    const embed = stuckSessionsEmbed(
      { kind: "cleared", at: 20 * MINUTE, since: 5 * MINUTE, count: 0, peakCount: 55, repeat: false },
      CONFIG,
    )
    expect(embed.title).toContain("no longer stuck")
    expect(embed.fields.map((f) => f.value)).toContain("55")
    expect(embed.fields.map((f) => f.value)).toContain("15 min")
  })
})
