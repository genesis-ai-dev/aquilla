import { afterEach, describe, expect, it, vi } from "vitest"
import { POSTHOG_EU_INGEST_HOST, resolvePosthogHost, shipLog } from "../posthog-logs"

// AQU-854: worker request/error logs go to PostHog EU Cloud. The region lives
// in the ingest hostname, so an unset POSTHOG_HOST used to send every 4xx/5xx
// log record — paths, status codes, error-body snippets — to the US project.
// These guard the EU default, the explicit override, and the OTLP endpoint
// the host is spliced into.
describe("sync-worker PostHog ingest region (AQU-854)", () => {
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
    await shipLog({ POSTHOG_KEY: "phc_test" }, "sync", "error", "boom")

    expect(postedUrl(spy)).toBe("https://eu.i.posthog.com/i/v1/logs")
    const init = (spy.mock.calls[0] as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer phc_test")
  })

  it("builds the OTLP logs endpoint on an explicitly configured host", async () => {
    const spy = stubFetch()
    await shipLog(
      { POSTHOG_KEY: "phc_test", POSTHOG_HOST: "https://telemetry.aquilla.app" },
      "sync",
      "warn",
      "boom",
    )

    expect(postedUrl(spy)).toBe("https://telemetry.aquilla.app/i/v1/logs")
  })

  it("ships nothing when POSTHOG_KEY is blank, so a region cutover cannot leak the retired token", async () => {
    // wrangler.toml intentionally carries POSTHOG_KEY = "" until the EU project
    // token exists; a blank key must be a clean no-op, not a keyless POST.
    const spy = stubFetch()
    await shipLog({ POSTHOG_KEY: "" }, "sync", "error", "boom")
    await shipLog({}, "sync", "error", "boom")

    expect(spy).not.toHaveBeenCalled()
  })
})
