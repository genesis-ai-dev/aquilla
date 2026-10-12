import { afterEach, describe, expect, it, vi } from "vitest"
import { POSTHOG_EU_INGEST_HOST, resolvePosthogHost, shipErrorResponse, shipLog } from "../posthog-logs"

// AQU-854: worker request/error logs go to PostHog EU Cloud. The region lives
// in the ingest hostname, so an unset POSTHOG_HOST used to send every 4xx/5xx
// log record — paths, status codes, error-body snippets — to the US project.
// These guard the EU default, the explicit override, and the OTLP endpoint
// the host is spliced into.
describe("auth-worker PostHog ingest region (AQU-854)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const stubFetch = (): ReturnType<typeof vi.fn> => {
    const spy = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })))
    vi.stubGlobal("fetch", spy)
    return spy
  }

  const postedUrl = (spy: ReturnType<typeof vi.fn>): string =>
    (spy.mock.calls[0] as [string, RequestInit])[0]

  it("defaults to the EU ingest host when POSTHOG_HOST is unset", () => {
    expect(resolvePosthogHost(undefined)).toBe("https://eu.i.posthog.com")
    expect(POSTHOG_EU_INGEST_HOST).toBe("https://eu.i.posthog.com")
  })

  it("never resolves to a US host for any absent-ish POSTHOG_HOST", () => {
    for (const raw of [undefined, "", "   "]) {
      const host = resolvePosthogHost(raw)
      expect(host).toBe("https://eu.i.posthog.com")
      expect(host).not.toContain("us.i.posthog.com")
    }
  })

  it("honours an explicit POSTHOG_HOST override", () => {
    expect(resolvePosthogHost("https://telemetry.aquilla.app")).toBe("https://telemetry.aquilla.app")
  })

  it("builds the OTLP logs endpoint on the EU host by default", async () => {
    const spy = stubFetch()
    await shipLog({ POSTHOG_KEY: "phc_test" }, "identity", "error", "boom")

    expect(postedUrl(spy)).toBe("https://eu.i.posthog.com/i/v1/logs")
    const init = (spy.mock.calls[0] as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer phc_test")
  })

  it("builds the OTLP logs endpoint on an explicitly configured host", async () => {
    const spy = stubFetch()
    await shipLog(
      { POSTHOG_KEY: "phc_test", POSTHOG_HOST: "https://telemetry.aquilla.app" },
      "identity",
      "warn",
      "boom",
    )

    expect(postedUrl(spy)).toBe("https://telemetry.aquilla.app/i/v1/logs")
  })

  it("ships nothing when POSTHOG_KEY is blank, so a region cutover cannot leak the retired token", async () => {
    // Local and e2e profiles omit the key; a blank key must be a clean no-op.
    const spy = stubFetch()
    await shipLog({ POSTHOG_KEY: "" }, "identity", "error", "boom")
    await shipLog({}, "identity", "error", "boom")

    expect(spy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// [Pen test] Auth & session mgmt (2026-10-05, OPS-42): credential-bearing URL
// paths must not reach PostHog Logs. Eight routes carry a live invite or
// access-link token as a path segment (D5), and the 4xx cases are the ordinary
// ones — a mistyped PIN on /access-links/:token/redeem 401s while the link is
// still live; a lapsed session on /invites/:token/accept 401s in authMiddleware
// before the route reads the invite at all. Each of these assertions fails
// against the pre-fix `shipErrorResponse`, which shipped `url.pathname` raw.
// ---------------------------------------------------------------------------
describe("auth-worker 4xx log shipping redacts path credentials (OPS-42)", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  const TOKEN = "Zt7Jq2bX9yLm4Rn8Ks3Wd6Pv1Hc5Tg0Ub2Ae4Yi7Qo"
  const env = { POSTHOG_KEY: "phc_test", POSTHOG_HOST: "https://eu.i.posthog.com" }

  const shipped = async (path: string, status: number, body = '{"error":"nope"}') => {
    const spy: ReturnType<typeof vi.fn> = vi.fn(() =>
      Promise.resolve(new Response("{}", { status: 200 })),
    )
    vi.stubGlobal("fetch", spy)
    await shipErrorResponse(
      env,
      "aquilla-identity",
      new Request(`https://api.aquilla.app${path}`, { method: "POST" }),
      new Response(body, { status }),
    )
    return (spy.mock.calls[0] as [string, RequestInit])[1].body as string
  }

  it("never ships an access-link token — the wrong-PIN 401 leaves the link live", async () => {
    const body = await shipped(`/api/v2/access-links/${TOKEN}/redeem`, 401, '{"error":"Dead link"}')
    expect(body).not.toContain(TOKEN)
    expect(body).toContain("/api/v2/access-links/:token/redeem")
  })

  it("never ships an invite token on the 401 authMiddleware returns for a lapsed session", async () => {
    const body = await shipped(`/api/v2/invites/${TOKEN}/accept`, 401, '{"error":"Token expired"}')
    expect(body).not.toContain(TOKEN)
  })

  it.each([
    `/api/v2/invites/${TOKEN}/preview`,
    `/api/v2/orgs/invite-preview/${TOKEN}`,
    `/api/v2/projects/invite-preview/${TOKEN}`,
    `/api/v2/orgs/41/invites/${TOKEN}`,
    `/api/v2/projects/d290f1ee-6c54-4b01-90e6-d701748f0851/invites/${TOKEN}`,
  ])("never ships the credential in %s", async (path) => {
    expect(await shipped(path, 404)).not.toContain(TOKEN)
  })

  it("still names the route and keeps the non-secret ids, so logs stay useful", async () => {
    const body = await shipped(`/api/v2/orgs/41/invites/${TOKEN}`, 403)
    expect(body).toContain("/api/v2/orgs/41/invites/:token")
    expect(body).toContain('"http.status"')
  })

  it("leaves a path with no credential untouched", async () => {
    const body = await shipped("/api/v1/ai/agent/run", 500, '{"error":"boom"}')
    expect(body).toContain("/api/v1/ai/agent/run")
  })
})
