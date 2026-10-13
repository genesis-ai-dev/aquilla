// AQU-1849 — the chat proxy's upstream call is deadline-bounded, two ways.
//
// Before this, `POST /api/v1/chat/completions` passed no abort signal unless
// the request was metered, so a provider that accepted the connection and then
// went quiet pinned the Worker invocation until the platform killed it. The
// user saw a spinner that resolved only when their own browser gave up, and
// the one log line said nothing about which vendor was at fault.
//
// The two shapes are deliberately different, and that difference is the point:
//
//   * `stream: false` → a TOTAL deadline. Nothing arrives until the whole
//     completion is done, so time-to-first-byte IS time-to-answer.
//   * `stream: true`  → a FIRST-BYTE deadline, disarmed the moment the headers
//     land. A generation that streams for minutes is not a hang; a provider
//     that never sends frame one is.
//
// On controlling time: the production deadlines are 120 s / 45 s, and fake
// timers deadlock this pool (the route's Postgres round-trips need real ones).
// So the tests that must watch a deadline FIRE borrow the shortest real
// deadline in the registry for its duration only — the deadline object, its
// `timedOut()` and the 504 mapping under test are all the real code. The tests
// that only need the deadline ARMED use the real durations untouched.

import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import { VENDOR_TIMEOUT_MS } from "../../../shared/vendor-timeouts"

const SHORTEST: keyof typeof VENDOR_TIMEOUT_MS = "aquifer"

vi.mock("../../../shared/vendor-timeouts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../shared/vendor-timeouts")>()
  return {
    ...actual,
    // Duration only. Everything the assertions touch — arming, abort reason,
    // timedOut(), clear() — is `actual`'s implementation.
    vendorDeadline: (_vendor: keyof typeof actual.VENDOR_TIMEOUT_MS, linked?: AbortSignal | null) =>
      actual.vendorDeadline(SHORTEST, linked),
  }
})

const app = (await import("../index")).default
const { seedUser, jwtFor, authHeader } = await import("./helpers/db")

const MODEL = "anthropic/claude-sonnet-4.5"
/** The real deadline we borrowed, plus room for the route's DB round-trips. */
const WAIT_BUDGET_MS = VENDOR_TIMEOUT_MS[SHORTEST] + 20_000

function chatBody(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    model: MODEL,
    messages: [{ role: "user", content: "Hello" }],
    stream: false,
    ...extra,
  })
}

function testEnv(): typeof env {
  return Object.assign(Object.create(env), { OPENROUTER_API_KEY: "test-key" })
}

afterEach(() => vi.restoreAllMocks())

/**
 * A vendor that accepts the request and never answers — it settles ONLY when
 * the deadline aborts the signal it was handed. This is the ticket's "point
 * the vendor URL at a hanging stub", in-process.
 */
function stubHangingUpstream(): () => AbortSignal | undefined {
  let seen: AbortSignal | undefined
  vi.spyOn(globalThis, "fetch").mockImplementation(
    ((_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        // No signal would mean no deadline at all — the pre-AQU-1849 hang.
        // Leaving the promise pending is what that regression looks like.
        if (!signal) return
        signal.addEventListener("abort", () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new DOMException("aborted", "AbortError"),
          ),
        )
      })
    }) as unknown as typeof globalThis.fetch,
  )
  return () => seen
}

/** A healthy provider, used to prove normal calls are unaffected. */
function stubHealthyUpstream(body: BodyInit, headers: Record<string, string>) {
  let seen: AbortSignal | undefined
  vi.spyOn(globalThis, "fetch").mockImplementation(
    ((_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined
      return Promise.resolve(new Response(body, { status: 200, headers }))
    }) as unknown as typeof globalThis.fetch,
  )
  return () => seen
}

describe("chat completions — vendor deadline", () => {
  it(
    "answers 504 with a vendor-named error when a non-streaming completion never arrives",
    async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {})
      await seedUser(18491, "chat-timeout-nonstream")
      const jwt = await jwtFor("chat-timeout-nonstream")
      stubHangingUpstream()

      const res = await app.request(
        "/api/v1/chat/completions",
        { method: "POST", headers: authHeader(jwt), body: chatBody() },
        testEnv(),
      )

      // 504, not the blanket 500 this used to become: the client can say "the
      // model did not respond" and offer a retry.
      expect(res.status).toBe(504)
      const body = (await res.json()) as { error?: string; message?: string }
      expect(body.error).toBe("openrouter_timeout")
      expect(body.message).toContain("openRouterNonStreaming")
      // And it is alertable per vendor.
      expect(
        log.mock.calls.some((c) =>
          String(c[0]).includes("[vendor-timeout] openRouterNonStreaming"),
        ),
      ).toBe(true)
    },
    WAIT_BUDGET_MS,
  )

  it(
    "answers 504 when a streaming completion never sends its first frame",
    async () => {
      vi.spyOn(console, "error").mockImplementation(() => {})
      await seedUser(18492, "chat-timeout-stream")
      const jwt = await jwtFor("chat-timeout-stream")
      stubHangingUpstream()

      const res = await app.request(
        "/api/v1/chat/completions",
        { method: "POST", headers: authHeader(jwt), body: chatBody({ stream: true }) },
        testEnv(),
      )

      expect(res.status).toBe(504)
      const body = (await res.json()) as { error?: string; message?: string }
      expect(body.error).toBe("openrouter_timeout")
      expect(body.message).toContain("openRouterStreamFirstByte")
    },
    WAIT_BUDGET_MS,
  )

  it("leaves a healthy non-streaming completion alone, with the deadline armed and untripped", async () => {
    await seedUser(18494, "chat-timeout-happy")
    const jwt = await jwtFor("chat-timeout-happy")
    const seen = stubHealthyUpstream(
      JSON.stringify({
        choices: [{ message: { content: "OK", role: "assistant" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { "Content-Type": "application/json" },
    )

    const res = await app.request(
      "/api/v1/chat/completions",
      { method: "POST", headers: authHeader(jwt), body: chatBody() },
      testEnv(),
    )

    expect(res.status).toBe(200)
    expect(seen()).toBeInstanceOf(AbortSignal)
    expect(seen()?.aborted).toBe(false)
  })

  it("disarms the streaming deadline once the headers land, so a slow generation is never cut off", async () => {
    // The regression a TOTAL deadline on a stream would cause: a long but
    // perfectly healthy generation killed mid-flight. The borrowed duration
    // here is shorter than the read below takes, so if the deadline were still
    // armed after the headers it would abort — and this would fail.
    await seedUser(18495, "chat-stream-firstbyte")
    const jwt = await jwtFor("chat-stream-firstbyte")
    const seen = stubHealthyUpstream(
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
      { "Content-Type": "text/event-stream" },
    )

    const res = await app.request(
      "/api/v1/chat/completions",
      { method: "POST", headers: authHeader(jwt), body: chatBody({ stream: true }) },
      testEnv(),
    )
    expect(res.status).toBe(200)
    const text = await res.text()

    await new Promise((r) => setTimeout(r, VENDOR_TIMEOUT_MS[SHORTEST] + 500))

    expect(text).toContain("hi")
    expect(seen()?.aborted).toBe(false)
  }, WAIT_BUDGET_MS)
})
