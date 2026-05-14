// CORS for browser-facing CQRS endpoints.
//
// The sync-worker is otherwise reached either as a partyserver WebSocket
// (no preflight needed) or by frontier-server using SYNC_SECRET_KEY
// (server-to-server, no preflight). The CQRS HTTP routes — /events,
// /cells/audit-stats, /cell-validators, and the /api/v1/projects/*
// read namespace — are the only paths the browser
// hits cross-origin, so we add CORS headers narrowly here rather than
// globally to keep partyserver upgrade responses untouched.
//
// Auth travels in `Authorization: Bearer <jwt>`, never cookies, so
// `Access-Control-Allow-Origin: *` is safe (and avoids hard-coding a list
// of frontend origins as the app moves between Vercel previews / local).

const BROWSER_PATH_PREFIXES = [
  "/events",
  "/cells/",
  "/cell-validators",
  "/api/v1/projects/",
]

export function isBrowserCorsPath(pathname: string): boolean {
  return BROWSER_PATH_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p),
  )
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
}

/** OPTIONS preflight responder for browser-facing paths. Returns null for
 * non-OPTIONS requests or non-browser paths so the dispatcher falls through. */
export function handleCorsPreflight(request: Request): Response | null {
  if (request.method !== "OPTIONS") return null
  const url = new URL(request.url)
  if (!isBrowserCorsPath(url.pathname)) return null
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

/** Add CORS headers to a response if the request path is browser-facing.
 * No-op for admin / partyserver paths. */
export function withCors(response: Response, request: Request): Response {
  const url = new URL(request.url)
  if (!isBrowserCorsPath(url.pathname)) return response
  const headers = new Headers(response.headers)
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
