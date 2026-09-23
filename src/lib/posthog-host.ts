/**
 * PostHog ingest region for the browser SPA (AQU-854).
 *
 * Aquilla's telemetry lives in PostHog **EU** Cloud. The region is baked into
 * the ingest hostname, so a producer that falls back to the US host silently
 * ships translator analytics — including session replays of unpublished draft
 * text — into a US processor. That is the exact disclosure the replay masking
 * in `posthog.ts` exists to prevent, so the default here must be EU and an
 * unset/blank `VITE_POSTHOG_HOST` must never degrade to US.
 *
 * Kept as a pure helper (rather than inline in `posthog.ts`) because that
 * module calls `posthog.init` at import time — the resolution rule is only
 * testable if it can be imported without the side effect.
 */
export const POSTHOG_EU_INGEST_HOST = "https://eu.i.posthog.com"

/**
 * Resolve the ingest host from the build-time env value.
 *
 * An explicit host wins (self-hosted / reverse-proxy deployments set it), but
 * `undefined`, `""` and whitespace all resolve to the EU default — an empty
 * `api_host` would otherwise make posthog-js post to the current origin.
 */
export function resolvePosthogHost(raw: string | undefined | null): string {
  const trimmed = raw?.trim()
  return trimmed ? trimmed : POSTHOG_EU_INGEST_HOST
}
