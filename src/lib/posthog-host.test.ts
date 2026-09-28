import { describe, expect, it } from "vitest"
import { POSTHOG_EU_INGEST_HOST, resolvePosthogHost } from "./posthog-host"

// AQU-854: Aquilla telemetry lives in PostHog EU Cloud. The region is encoded
// in the ingest hostname, so the *default* is the whole control — a producer
// that falls back to `us.i.posthog.com` ships browser analytics and session
// replays of unpublished draft translations into a US processor with no code
// change and no deploy to point at. These lock the fallback to EU.
describe("resolvePosthogHost (AQU-854 region default)", () => {
  it("defaults to the EU ingest host when VITE_POSTHOG_HOST is unset", () => {
    expect(resolvePosthogHost(undefined)).toBe("https://eu.i.posthog.com")
    expect(POSTHOG_EU_INGEST_HOST).toBe("https://eu.i.posthog.com")
  })

  it("never resolves to a US host for any absent-ish input", () => {
    for (const raw of [undefined, null, "", "   ", "\t\n"]) {
      const host = resolvePosthogHost(raw)
      expect(host).toBe("https://eu.i.posthog.com")
      expect(host).not.toContain("us.i.posthog.com")
      expect(host).not.toContain("us.posthog.com")
    }
  })

  it("honours an explicit host override (self-hosted / reverse proxy)", () => {
    expect(resolvePosthogHost("https://telemetry.aquilla.app")).toBe("https://telemetry.aquilla.app")
    expect(resolvePosthogHost("https://eu.i.posthog.com")).toBe("https://eu.i.posthog.com")
  })

  it("trims surrounding whitespace from an explicit host", () => {
    // A trailing newline in a CI-injected env var would otherwise produce an
    // unusable api_host that posthog-js resolves against the current origin.
    expect(resolvePosthogHost("  https://eu.i.posthog.com\n")).toBe("https://eu.i.posthog.com")
  })
})
