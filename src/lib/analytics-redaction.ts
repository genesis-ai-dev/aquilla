// Redaction at the analytics boundary — the last thing that runs before an
// event leaves the browser for PostHog (a third-party US processor).
//
// OPS-29 (docs/OPSEC-REVIEW-2026-09-14.md): several of this app's routes carry
// a live bearer credential *in the URL itself* — `/join/:token`,
// `/join-org/:token`, `/link/:token` in the path, `?token=` on
// `/reset-password` and `/verify-email` (plus `?username=` beside it). PostHog
// attaches `$current_url` / `$pathname` to every captured event, persists
// `$initial_current_url` / `$initial_referrer` as person properties, and stamps
// the same URL onto each session-replay snapshot. So for as long as one of
// those pages is open, every event exported the credential with it.
//
// The rule applied here: an analytics property whose *name* says it holds a URL
// never leaves with a credential in it. Redaction is by position (the segment
// after a known credential-bearing route prefix) and by query-parameter name,
// so a new event type or a new capture site inherits the protection without
// having to remember it.

/** What a redacted value is replaced with — recognizable in PostHog. */
export const REDACTED = "[redacted]"

/**
 * `URLSearchParams` percent-encodes the brackets when it serializes. Undo that
 * on the way out so a redacted query parameter reads the same as a redacted
 * path segment in a PostHog dashboard.
 */
const REDACTED_ENCODED = encodeURIComponent(REDACTED)

/**
 * Route prefixes whose *next* path segment is a bearer credential.
 * Keep in sync with the token-bearing routes in `src/App.tsx`.
 */
const CREDENTIAL_PATH_PREFIXES = new Set(["join", "join-org", "link"])

/** Query-parameter names that carry a credential or a directly identifying value. */
const CREDENTIAL_QUERY_KEYS = new Set([
  "token",
  "t",
  "pin",
  "code",
  "key",
  "api_key",
  "apikey",
  "secret",
  "password",
  "invite",
  "username",
  "email",
])

/** Base used to parse path-only values (`$pathname`, `route`). Never emitted. */
const RELATIVE_BASE = "http://redaction.invalid"

function redactPathSegments(pathname: string): { pathname: string; changed: boolean } {
  const segments = pathname.split("/")
  // segments[0] is "" for a leading slash; the route name is segments[1].
  const route = segments[1]?.toLowerCase()
  const credential = segments[2]
  if (route && CREDENTIAL_PATH_PREFIXES.has(route) && credential) {
    segments[2] = REDACTED
    return { pathname: segments.join("/"), changed: true }
  }
  return { pathname, changed: false }
}

function redactQueryParams(params: URLSearchParams): boolean {
  let changed = false
  for (const [key, value] of Array.from(params.entries())) {
    if (value && CREDENTIAL_QUERY_KEYS.has(key.toLowerCase())) {
      params.set(key, REDACTED)
      changed = true
    }
  }
  return changed
}

/**
 * Redact credentials from anything URL-shaped: an absolute URL, a path, or a
 * referrer. Returns the input **unchanged** when there is nothing to redact, so
 * ordinary URLs are never reshaped by parser normalization.
 */
export function redactUrlLike(value: string): string {
  if (!value) return value

  let url: URL
  let relative = false
  try {
    url = new URL(value)
  } catch {
    try {
      url = new URL(value, RELATIVE_BASE)
      relative = true
    } catch {
      return value
    }
  }

  const path = redactPathSegments(url.pathname)
  url.pathname = path.pathname
  const queryChanged = redactQueryParams(url.searchParams)
  if (!path.changed && !queryChanged) return value

  const rebuilt = relative ? `${url.pathname}${url.search}${url.hash}` : url.toString()
  return rebuilt.split(REDACTED_ENCODED).join(REDACTED)
}

/**
 * Does this property name hold something URL-shaped? Deliberately name-based
 * rather than an explicit allowlist of PostHog's `$`-properties: the library
 * adds new ones (`$session_entry_url`, `$prev_pageview_pathname`, …) between
 * versions, and our own capture sites add things like `route`.
 */
export function isUrlLikeKey(key: string): boolean {
  const k = key.toLowerCase()
  return (
    k.includes("url") ||
    k.includes("pathname") ||
    k.includes("referrer") ||
    k === "route" ||
    k === "path"
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Session-replay snapshots carry the page URL of their own accord: rrweb's Meta
 * event holds `data.href`, which is not an event property and so is not covered
 * by the property pass below.
 */
function redactSnapshotData(snapshot: unknown): unknown {
  if (!Array.isArray(snapshot)) return snapshot
  return snapshot.map((entry) => {
    if (!isRecord(entry) || !isRecord(entry.data)) return entry
    const data = entry.data
    const href = data.href
    const payload = data.payload
    const nextHref = typeof href === "string" ? redactUrlLike(href) : href
    const nextPayload =
      isRecord(payload) && typeof payload.href === "string"
        ? { ...payload, href: redactUrlLike(payload.href) }
        : payload
    if (nextHref === href && nextPayload === payload) return entry
    return { ...entry, data: { ...data, href: nextHref, ...(payload === undefined ? {} : { payload: nextPayload }) } }
  })
}

/** Redact every URL-shaped value in one property bag. */
export function redactAnalyticsProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(properties)) {
    if (key === "$snapshot_data") {
      out[key] = redactSnapshotData(value)
    } else if (typeof value === "string" && isUrlLikeKey(key)) {
      out[key] = redactUrlLike(value)
    } else {
      out[key] = value
    }
  }
  return out
}

/** The shape `before_send` hands us — structural, so this module needs no posthog import. */
export interface RedactableCaptureEvent {
  event: string
  properties?: Record<string, unknown>
  $set?: Record<string, unknown>
  $set_once?: Record<string, unknown>
}

/**
 * `before_send` hook: redact credentials out of every captured event, including
 * `$pageview`, `$exception`, `$snapshot` (session replay) and the `$set_once`
 * person properties PostHog uses to persist `$initial_current_url`.
 *
 * Never drops events — it only rewrites values — so analytics keep working.
 */
export function redactCaptureEvent<T extends RedactableCaptureEvent>(event: T | null): T | null {
  if (!event) return event
  const next: T = { ...event }
  if (next.properties) next.properties = redactAnalyticsProperties(next.properties)
  if (next.$set) next.$set = redactAnalyticsProperties(next.$set)
  if (next.$set_once) next.$set_once = redactAnalyticsProperties(next.$set_once)
  return next
}
