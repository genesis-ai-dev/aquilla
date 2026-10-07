// Ship structured worker logs to PostHog Logs via OTLP/HTTP JSON.
//
// PostHog's logs product accepts OpenTelemetry log records at
// `POST {host}/i/v1/logs` authenticated with the *project* token (phc_…, the
// same public token the SPA uses — safe to keep in wrangler.toml [vars]).
// When POSTHOG_KEY is unset (local dev, e2e) shipping is a no-op.
//
// Callers pass the returned promise to `ctx.waitUntil` so the response isn't
// blocked; failures are swallowed — telemetry must never take down a request.

const OTLP_SEVERITY = { info: 9, warn: 13, error: 17 } as const

export type LogLevel = keyof typeof OTLP_SEVERITY

/**
 * PostHog ingest region (AQU-854). Aquilla's telemetry lives in PostHog **EU**
 * Cloud; the region is part of the ingest hostname, so a worker that falls
 * back to the US host silently ships request/error logs into a US processor.
 * EU is therefore the default and an unset or blank `POSTHOG_HOST` must never
 * degrade to US.
 */
export const POSTHOG_EU_INGEST_HOST = "https://eu.i.posthog.com"

/** Resolve the ingest host: an explicit non-blank value wins, else EU. */
export function resolvePosthogHost(raw: string | undefined | null): string {
  const trimmed = raw?.trim()
  return trimmed ? trimmed : POSTHOG_EU_INGEST_HOST
}

export interface PosthogLogEnv {
  POSTHOG_KEY?: string
  POSTHOG_HOST?: string
}

export function shipLog(
  env: PosthogLogEnv,
  service: string,
  level: LogLevel,
  message: string,
  attributes: Record<string, string | number | undefined> = {},
): Promise<void> {
  if (!env.POSTHOG_KEY) return Promise.resolve()
  const host = resolvePosthogHost(env.POSTHOG_HOST)
  const body = {
    resourceLogs: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: service } }],
        },
        scopeLogs: [
          {
            scope: { name: "worker" },
            logRecords: [
              {
                timeUnixNano: `${Date.now()}000000`,
                severityText: level.toUpperCase(),
                severityNumber: OTLP_SEVERITY[level],
                body: { stringValue: message },
                attributes: Object.entries(attributes)
                  .filter(([, v]) => v !== undefined)
                  .map(([key, v]) => ({
                    key,
                    value: typeof v === "number" ? { intValue: Math.round(v) } : { stringValue: String(v) },
                  })),
              },
            ],
          },
        ],
      },
    ],
  }
  return fetch(`${host}/i/v1/logs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.POSTHOG_KEY}`,
    },
    body: JSON.stringify(body),
  })
    .then(() => undefined)
    .catch(() => undefined)
}

/**
 * Log a non-OK response (4xx/5xx) with enough shape to answer "what failed
 * for this user" — route, method, status, and a snippet of the error body.
 */
export async function shipErrorResponse(
  env: PosthogLogEnv,
  service: string,
  request: Request,
  response: Response,
): Promise<void> {
  const url = new URL(request.url)
  let bodySnippet: string | undefined
  try {
    bodySnippet = (await response.clone().text()).slice(0, 500)
  } catch {
    // body already consumed / not readable — status alone is still useful
  }
  await shipLog(
    env,
    service,
    response.status >= 500 ? "error" : "warn",
    `${request.method} ${url.pathname} → ${response.status}`,
    {
      "http.method": request.method,
      "http.path": url.pathname,
      "http.status": response.status,
      "error.body": bodySnippet,
    },
  )
}
