// Same-origin resource proxy — the SERVER half (AQU-627).
//
// Translators in surveillance-sensitive contexts reach the app over a safe
// path, but the SPA also makes "sideways" content fetches to third-party hosts
// (Door43/DCS, the Free Use Bible API, the eBible corpus). Those expose
// meaningful domains in DNS/SNI on the translator's network even when the main
// app is reached safely. This module is the request handler for a Worker that
// runs on a same-domain subdomain (e.g. resources.aquilla.app) and forwards an
// allow-listed set of content hosts, so client traffic only ever names our
// domain.
//
// It is deliberately dependency-free and reads NO `import.meta.env` so a
// Cloudflare Worker can import it directly. The client-side URL rewriter lives
// in ./resource-proxy.ts and shares the allow-list below.

/**
 * The inventory of third-party CONTENT hosts the browser fetches directly
 * today (the "sideways server accesses" flagged on the 2026-07-17 security
 * call). Only these hosts may be proxied — the handler refuses anything else so
 * the Worker can never be turned into an open proxy / SSRF pivot.
 *
 * Intentionally excluded (not browser content fetches / handled elsewhere):
 *   - provider/API calls already routed through our own Workers (openrouter via
 *     auth-worker chat proxy, api.aquilla.app, sync-worker),
 *   - telemetry (PostHog),
 *   - build-time-only or migration tooling (gitlab, git-lfs),
 *   - documentation/reference links that are never fetched (matecat guides,
 *     huggingface, OASIS/W3C schema URLs).
 */
export const EXTERNAL_CONTENT_HOSTS: readonly string[] = [
  "git.door43.org", // DCS catalog + Gitea API + raw files, OBS repo
  "cdn.door43.org", // Door43 media (OBS images)
  "bible.helloao.org", // Free Use Bible API (helloao)
  "raw.githubusercontent.com", // BibleNLP/ebible corpus + translations.csv
]

/** True when `host` is an allow-listed content host we're willing to proxy. */
export function isProxyableHost(host: string): boolean {
  return EXTERNAL_CONTENT_HOSTS.includes(host)
}

/** Response headers worth passing through from the upstream so caching and
 *  content-type behave the same as a direct fetch. Hop-by-hop and
 *  auth/cookie headers are deliberately dropped. */
const PASS_THROUGH_HEADERS = [
  "content-type",
  "content-length",
  "content-disposition",
  "cache-control",
  "etag",
  "last-modified",
  "expires",
  "vary",
] as const

/** Request headers forwarded upstream — enough for conditional + ranged GETs
 *  (so caching keeps working) without leaking the caller's cookies/auth. */
const FORWARD_HEADERS = [
  "accept",
  "accept-language",
  "range",
  "if-none-match",
  "if-modified-since",
] as const

export interface ProxyResourceDeps {
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Override the allow-list (tests). Defaults to EXTERNAL_CONTENT_HOSTS. */
  allowedHosts?: readonly string[]
}

/**
 * Handle one proxied request. The path names the upstream host as its first
 * segment: `/{host}/{rest...}` → `https://{host}/{rest...}?{query}`.
 *
 * e.g. `GET /git.door43.org/api/v1/catalog/search?lang=en`
 *      → `https://git.door43.org/api/v1/catalog/search?lang=en`
 *
 * Only allow-listed hosts and safe (GET/HEAD) methods are honoured; everything
 * else is refused. All upstreams are https.
 */
export async function proxyResourceRequest(
  request: Request,
  deps: ProxyResourceDeps = {},
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const allowed = deps.allowedHosts ?? EXTERNAL_CONTENT_HOSTS

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    })
  }

  const url = new URL(request.url)
  const segments = url.pathname.replace(/^\/+/, "").split("/")
  const host = segments.shift() ?? ""

  if (!host || !allowed.includes(host)) {
    return new Response("Forbidden: host not proxyable", { status: 403 })
  }

  const rest = segments.join("/")
  const upstream = `https://${host}/${rest}${url.search}`

  const forwardHeaders = new Headers()
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name)
    if (value) forwardHeaders.set(name, value)
  }

  let upstreamRes: Response
  try {
    upstreamRes = await fetchImpl(upstream, {
      method: request.method,
      headers: forwardHeaders,
      redirect: "follow",
    })
  } catch (err) {
    return new Response(
      `Upstream fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      { status: 502 },
    )
  }

  const headers = new Headers()
  for (const name of PASS_THROUGH_HEADERS) {
    const value = upstreamRes.headers.get(name)
    if (value) headers.set(name, value)
  }
  // The SPA (aquilla.app) fetches this subdomain cross-origin. These content
  // hosts are already public + keyless, so a wildcard mirrors their own CORS.
  headers.set("access-control-allow-origin", "*")

  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers,
  })
}
