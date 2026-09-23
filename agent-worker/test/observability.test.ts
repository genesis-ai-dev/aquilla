import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest"
import { createApp, SLOW_REQUEST_MS, slowThresholdFor } from "../src/app"
import { MAX_TIMEOUT_MS } from "../src/exec"
import type { Env } from "../src/types"
import type { SandboxLike, SandboxRunResult, SandboxReadResult, SandboxWriteResult } from "../src/sandbox"

// ---------------------------------------------------------------------------
// AQU-1021 — every agent-worker request that outruns its slow threshold must
// surface as a `[slow-request]` console line (the dev-visible signal) and, when
// POSTHOG_KEY is set, as a `slow:` warn record in PostHog Logs.
//
// Time is driven by a stubbed Date.now rather than real waiting: the middleware
// measures `Date.now()` deltas, so a scripted clock reproduces a 6s request in
// microseconds and keeps the suite deterministic.
// ---------------------------------------------------------------------------

/** A sandbox whose runCode advances the fake clock by `advanceMs`. */
class SlowSandbox implements SandboxLike {
  constructor(private readonly advanceMs: number) {}
  async runCode(): Promise<SandboxRunResult> {
    clock += this.advanceMs
    return { logs: { stdout: [], stderr: [] }, results: [] }
  }
  async writeFile(path: string): Promise<SandboxWriteResult> {
    clock += this.advanceMs
    return { success: true, path }
  }
  async readFile(path: string): Promise<SandboxReadResult> {
    clock += this.advanceMs
    return { success: true, path, content: "" }
  }
  async destroy(): Promise<void> {
    clock += this.advanceMs
  }
}

let clock = 0

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    AGENT_SANDBOX_KEY: "test-key",
    Sandbox: {} as Env["Sandbox"],
    SNAPSHOTS: { get: async () => null } as unknown as Env["SNAPSHOTS"],
    ...overrides,
  }
}

function harness(sandbox: SandboxLike, env: Env = makeEnv()) {
  const app = createApp({ resolveSandbox: () => sandbox })
  return (req: Request) => app.fetch(req, env)
}

const AUTH = { Authorization: "Bearer test-key" }

let warnSpy: MockInstance<typeof console.warn>
let fetchSpy: MockInstance<typeof globalThis.fetch>

beforeEach(() => {
  clock = 1_000_000
  vi.spyOn(Date, "now").mockImplementation(() => clock)
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"))
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** The `[slow-request]` lines emitted so far. */
function slowLines(): string[] {
  return warnSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[slow-request]"))
}

/**
 * Log shipping is fire-and-forget, and the 4xx/5xx path awaits a body clone
 * before it ships — so let the pending microtasks/IO settle before asserting.
 * Only `Date.now` is stubbed here, so real timers still fire.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Message bodies of the OTLP log records shipped to PostHog. */
function shippedMessages(): string[] {
  return fetchSpy.mock.calls.flatMap((call) => {
    const init = call[1] as RequestInit | undefined
    if (typeof init?.body !== "string") return []
    const parsed = JSON.parse(init.body) as {
      resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ body: { stringValue: string } }> }> }>
    }
    return parsed.resourceLogs.flatMap((rl) =>
      rl.scopeLogs.flatMap((sl) => sl.logRecords.map((lr) => lr.body.stringValue)),
    )
  })
}

describe("slow-request threshold", () => {
  it("control-plane routes use the 5s bar shared with auth-worker/sync-worker", () => {
    expect(SLOW_REQUEST_MS).toBe(5_000)
    expect(slowThresholdFor("/sessions/s1/files")).toBe(SLOW_REQUEST_MS)
    expect(slowThresholdFor("/health")).toBe(SLOW_REQUEST_MS)
  })

  // A 60s default / 300s max exec is the documented contract, so holding /exec
  // to 5s would warn on every normal agent run and turn the signal into noise.
  it("/exec is held to its own hard ceiling, not the 5s bar", () => {
    expect(slowThresholdFor("/sessions/s1/exec")).toBe(MAX_TIMEOUT_MS)
    expect(MAX_TIMEOUT_MS).toBeGreaterThan(SLOW_REQUEST_MS)
  })
})

describe("slow-request logging", () => {
  it("logs a [slow-request] line when a control-plane request exceeds 5s", async () => {
    const res = await harness(new SlowSandbox(6_000))(
      new Request("http://x/sessions/s1/files?path=a.txt", { headers: AUTH }),
    )
    expect(res.status).toBe(200)
    expect(slowLines()).toEqual([
      "[slow-request] GET /sessions/s1/files took 6000ms (status 200)",
    ])
  })

  it("stays silent for a fast request", async () => {
    const res = await harness(new SlowSandbox(50))(
      new Request("http://x/sessions/s1/files?path=a.txt", { headers: AUTH }),
    )
    expect(res.status).toBe(200)
    expect(slowLines()).toEqual([])
  })

  // The regression AQU-1005 guards against: a SUCCESSFUL but slow request must
  // still be logged — only-4xx/5xx logging left saturation invisible.
  it("logs slow requests that succeeded, not just failures", async () => {
    await harness(new SlowSandbox(9_000))(
      new Request("http://x/sessions/s1/files?path=a.txt", { headers: AUTH }),
    )
    expect(slowLines()).toHaveLength(1)
    expect(slowLines()[0]).toContain("status 200")
  })

  it("does not warn on a normal multi-second exec", async () => {
    const res = await harness(new SlowSandbox(30_000))(
      new Request("http://x/sessions/s1/exec", {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ language: "js", code: "1+1" }),
      }),
    )
    expect(res.status).toBe(200)
    expect(slowLines()).toEqual([])
  })

  // Registration order matters: the middleware is mounted before /health and
  // before the bearer-auth guard, so both are covered.
  it("covers unauthenticated rejections and /health", async () => {
    await harness(new SlowSandbox(0))(new Request("http://x/health"))
    expect(slowLines()).toEqual([])

    clock = 1_000_000
    const app = createApp({
      resolveSandbox: () => new SlowSandbox(0),
    })
    const res = await app.fetch(
      new Request("http://x/sessions/s1/exec", { method: "POST", body: "{}" }),
      makeEnv({ POSTHOG_KEY: "phc_test" }),
    )
    expect(res.status).toBe(401)
    await flush()
    // The 401 is shipped as an error response even though no route handler ran
    // — proof the middleware sits ahead of the bearer-auth guard.
    expect(shippedMessages()).toContain("POST /sessions/s1/exec → 401")
  })
})

describe("PostHog log shipping", () => {
  it("ships a slow: record when POSTHOG_KEY is set", async () => {
    await harness(
      new SlowSandbox(6_000),
      makeEnv({ POSTHOG_KEY: "phc_test" }),
    )(new Request("http://x/sessions/s1/files?path=a.txt", { headers: AUTH }))

    expect(shippedMessages()).toContain("slow: GET /sessions/s1/files (6000ms)")
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    // AQU-854: telemetry ingests into PostHog EU Cloud by default.
    expect(url).toBe("https://eu.i.posthog.com/i/v1/logs")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer phc_test")
  })

  it("ships nothing when POSTHOG_KEY is unset, but still logs locally", async () => {
    await harness(new SlowSandbox(6_000))(
      new Request("http://x/sessions/s1/files?path=a.txt", { headers: AUTH }),
    )
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(slowLines()).toHaveLength(1)
  })
})
