// Baseline HTTP security headers for the aquilla-web Worker.
//
// Scope caveat, stated up front because it bounds what these buy us:
// wrangler.toml sets `run_worker_first = ["/"]`, so Cloudflare's asset router
// serves any request that matches a built file WITHOUT invoking this Worker.
// These headers therefore land on the HTML surface — `/`, the STATIC_PAGES
// marketing routes, and every SPA route that falls through to
// `not_found_handling = "single-page-application"` (/app, /project/…,
// /join/:token) — but not on hashed asset responses under /assets/. That is
// the surface where framing, sniffing, and referrer leakage actually matter,
// and HSTS pins the host from any one of these responses.
//
// Deliberately NOT included: a full Content-Security-Policy. The SPA loads
// Vite-hashed modules, inline theme/brand bootstrap, PostHog, and remote model
// hosts (R2 / Hugging Face), so a script-src policy needs a nonce pipeline
// through the prerender step to avoid breaking the app on deploy. Only the
// framing directive is carried here; the rest is tracked in docs/OPSEC.md.

/** Hosts that must not get HSTS: no TLS, and pinning them breaks local dev. */
function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  )
}

/**
 * Headers applied to every Worker-served response.
 *
 * - `X-Content-Type-Options: nosniff` — stops a user-uploaded or R2-proxied
 *   body being re-interpreted as HTML/JS by MIME sniffing.
 * - `Referrer-Policy: strict-origin-when-cross-origin` — invite links carry a
 *   bearer token in the path (/join/:token, /join-org/:token). This is the
 *   modern browser default, but stating it explicitly means an older or
 *   differently-configured browser can't send that path to a third-party host
 *   in a `Referer` header.
 * - `X-Frame-Options: DENY` + `frame-ancestors 'none'` — the app has
 *   irreversible actions behind single clicks (archive project, remove member,
 *   apply/undo agent changesets); clickjacking them is worth closing. Nothing
 *   in the product is designed to be embedded: the Monday.com integration is
 *   API + OAuth-popup based, not a board-view iframe, and the Tauri shell
 *   loads the built assets locally rather than through this Worker.
 * - `Permissions-Policy` — the app records audio (CellAudioRecordButton), so
 *   microphone stays self-allowed; camera/geolocation/payment are features it
 *   never uses, and denying them keeps an injected third-party frame from
 *   inheriting them. Unlisted features keep their browser defaults.
 */
const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "Permissions-Policy": "camera=(), geolocation=(), payment=(), microphone=(self)",
}

/**
 * HSTS. `includeSubDomains` covers api.aquilla.app and dev.aquilla.app, which
 * are already HTTPS-only behind Cloudflare. `preload` is deliberately omitted:
 * getting onto the preload list is effectively irreversible and is an
 * operator decision, not a code one.
 */
const HSTS = "max-age=31536000; includeSubDomains"

/**
 * Return a copy of `response` carrying the baseline security headers. Existing
 * values are overwritten so a header set upstream (e.g. by the asset binding)
 * can't downgrade the policy; unrelated headers — Cache-Control, the
 * X-Robots-Tag added for non-canonical hosts — pass through untouched.
 */
export function withSecurityHeaders(response: Response, requestUrl: string): Response {
  const url = new URL(requestUrl)
  const wrapped = new Response(response.body, response)
  for (const [name, value] of Object.entries(BASE_HEADERS)) {
    wrapped.headers.set(name, value)
  }
  if (url.protocol === "https:" && !isLocalHost(url.hostname)) {
    wrapped.headers.set("Strict-Transport-Security", HSTS)
  }
  return wrapped
}
