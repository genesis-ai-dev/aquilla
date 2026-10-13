// CORS for browser-facing CQRS endpoints.
//
// The sync-worker is otherwise reached either as a partyserver WebSocket
// (no preflight needed) or by auth-worker using SYNC_SECRET_KEY
// (server-to-server, no preflight). The CQRS HTTP routes — /events,
// /cells/audit-stats, /cell-validators — are the only paths the browser
// hits cross-origin, so we add CORS headers narrowly here rather than
// globally to keep partyserver upgrade responses untouched.
//
// Auth travels in `Authorization: Bearer <jwt>`, never cookies, so
// `Access-Control-Allow-Origin: *` is safe (and avoids hard-coding a list
// of frontend origins as the app moves between Vercel previews / local).

const BROWSER_PATH_PREFIXES = [
  "/events",
  "/checking",
  "/cells/",
  "/cell-validators",
  "/import",
  "/api/v1/",
  // MCP OAuth discovery (RFC 9728): browser-based MCP clients fetch it.
  "/.well-known/oauth-protected-resource",
]

export function isBrowserCorsPath(pathname: string): boolean {
  return BROWSER_PATH_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p),
  )
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  // PUT/DELETE are needed by browser-facing /api/v1/ routes like voice
  // reference clip storage (PUT /api/v1/voice/reference/...). Without them the
  // global preflight answers before the route's own OPTIONS handler and the
  // browser blocks the PUT. Allowing a method here only permits the preflight;
  // each route still enforces what it actually accepts (405 otherwise).
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  // X-Source-Format: sent by the DOCX/PPTX original-bytes upload
  // (PUT /api/v1/projects/:id/files/:id/source). Omitting it here fails the
  // preflight, which broke every DOCX/PPTX source upload in prod (no r2_key
  // was ever written).
  "Access-Control-Allow-Headers": [
    "Authorization",
    "Content-Type",
    "X-Source-Format",
    "X-Source-Size",
    "X-Source-Sha256",
    "X-Artifact-Id",
    "X-Artifact-Name",
    "X-Artifact-Binding-Role",
    // X-Artifact-Target-Lang: sent by the same source PUT whenever the import
    // has a target lane, which is any lane but the default one (the default
    // lane's tag is "", so the client omits the header and the preflight
    // passed). Missing here, every target import into a NON-default lane died
    // in the browser with "Failed to fetch" and wrote nothing — invisible for
    // as long as the default lane was the only one anyone imported into
    // (AQU-1631).
    "X-Artifact-Target-Lang",
    "X-Artifact-Member-Path",
    // X-Doc-Name: the knowledge-base (reference document) upload's filename
    // header, percent-encoded (AQU-1762). Same header the identity host already
    // allows for the in-app upload, so a browser-based agent console can reach
    // POST /api/v1/external/projects/:id/knowledge too.
    "X-Doc-Name",
    "X-Artifact-Profile-Id",
    "X-Artifact-Profile-Version",
    "X-Artifact-Fidelity",
    "X-Update-Source-Sidecar",
    // Sent by MCP streamable-HTTP clients on every request after initialize.
    "Mcp-Protocol-Version",
  ].join(", "),
  // AQU-276: expose custom response headers so the browser-side fetch() can
  // read them via res.headers.get(). Without Expose-Headers, only the CORS
  // safelisted headers (Content-Type, etc.) are readable from JS.
  // WWW-Authenticate: the MCP 401 challenge that starts OAuth discovery.
  "Access-Control-Expose-Headers": "X-Export-Mode, X-Usfm-Lossy-Verse-Count, WWW-Authenticate",
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
