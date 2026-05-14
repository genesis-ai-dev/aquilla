// @aquilla/telemetry — error reporting + usage analytics interface.
//
// Apps depend on this package for a stable telemetry shape; the actual SDK
// (PostHog today, possibly Sentry/etc. later) plugs in via init(). Apps
// that don't want analytics call createNoopTelemetry() and the rest of
// their code never has to branch on whether telemetry is enabled.
//
// The pre-Phase-3 codex SPA wired PostHog directly in `src/lib/posthog.ts`.
// During 3a-final the workspace SPA's wiring switches to this interface.

export interface TelemetryClient {
  /** Identify the current user (post-login). */
  identify(userId: string, properties?: Record<string, unknown>): void

  /** Record a usage event. */
  capture(eventName: string, properties?: Record<string, unknown>): void

  /** Set a global property attached to every subsequent event. */
  setSuperProperty(key: string, value: unknown): void

  /** Opt-in to capturing (e.g. after consent banner approval). */
  optIn(): void

  /** Opt-out and clear in-flight queues. */
  optOut(): void

  /** Flush any pending events. Returns when delivery completes (or times out). */
  flush(timeoutMs?: number): Promise<void>
}

export interface TelemetryInitOptions {
  /** Provider key (PostHog project key, Sentry DSN, etc.). */
  apiKey: string
  /** Override the default API host. */
  apiHost?: string
  /** Whether to start opted-in. Caller drives this from its consent state. */
  consentGranted: boolean
  /** Called when the runtime needs to know whether to send events. */
  getConsentState?: () => boolean
}

/**
 * Returns a no-op TelemetryClient. Useful for tests, server-side renders,
 * and consent-denied users — call sites stay the same, capture() drops
 * silently.
 */
export function createNoopTelemetry(): TelemetryClient {
  return {
    identify() {},
    capture() {},
    setSuperProperty() {},
    optIn() {},
    optOut() {},
    async flush() {},
  }
}

/**
 * Returns a TelemetryClient backed by PostHog. The PostHog SDK is a peer
 * dependency — callers must install `posthog-js`. The factory lazy-imports
 * so this package doesn't drag the SDK into bundles that don't need it.
 *
 * Phase 3a-final wires this up in apps/workspace/. Other apps may not need
 * telemetry; they call createNoopTelemetry() or skip this package entirely.
 */
export async function createPosthogTelemetry(
  opts: TelemetryInitOptions,
): Promise<TelemetryClient> {
  const { default: posthog } = await import("posthog-js")
  posthog.init(opts.apiKey, {
    api_host: opts.apiHost ?? "https://us.i.posthog.com",
    persistence: "localStorage+cookie",
    capture_pageview: true,
    autocapture: false,
    disable_session_recording: true,
    opt_out_capturing_by_default: !opts.consentGranted,
  })

  return {
    identify(userId, properties) {
      posthog.identify(userId, properties)
    },
    capture(eventName, properties) {
      if (opts.getConsentState && !opts.getConsentState()) return
      posthog.capture(eventName, properties)
    },
    setSuperProperty(key, value) {
      posthog.register({ [key]: value })
    },
    optIn() {
      posthog.opt_in_capturing()
    },
    optOut() {
      posthog.opt_out_capturing()
    },
    async flush(_timeoutMs?: number) {
      // posthog-js queues client-side; explicit flush isn't exposed by the
      // public API. The page-unload beacon transport drains automatically.
    },
  }
}
