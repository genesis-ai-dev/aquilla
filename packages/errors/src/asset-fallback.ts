// Helpers around Workers Assets' SPA-fallback behavior + edge caching.
//
// Two interrelated problems get solved here:
//
// 1. SPA-fallback returns HTML for missing asset URLs.
//
//    Workers Assets `not_found_handling = "single-page-application"`
//    returns the index.html shell on any 404 — right for app routes
//    (so a deep link like `/projects/foo/bar` still mounts the SPA),
//    wrong for `/<slug>/assets/*` requests for stale hashed bundle
//    filenames. The browser sees `text/html` on a `.css`/`.js`/`.svg`
//    URL and refuses to use it ("non CSS MIME types are not allowed in
//    strict mode" / "'text/html' is not a valid JavaScript MIME type").
//
//    `rejectStaleAssetFallback()` detects this and converts the
//    response to a clean 404 so the browser hard-reloads the page
//    instead of trying to parse HTML as JS/CSS.
//
// 2. Cloudflare edge cache holds stale HTML across redeploys.
//
//    The cf-cache-status: HIT on `/<slug>/index.html` means the edge
//    is serving an OLD index.html that references asset hashes that no
//    longer exist (we redeploy, the hashes change, the edge keeps the
//    old HTML). The browser-facing `Cache-Control: max-age=0,
//    must-revalidate` doesn't help — that's a browser directive, not a
//    CF edge directive.
//
//    `tellCfNotToCacheHtml()` overrides Cache-Control on HTML responses
//    so the edge stops holding it. Hashed asset responses keep their
//    long max-age so per-deploy bundles stay cached.

const ASSET_EXT = /\.(css|js|mjs|map|svg|png|jpg|jpeg|webp|woff2?|ico)$/i

/**
 * Pass an asset response through, but if the request looked like an
 * asset URL and the response came back as HTML (the SPA fallback),
 * return a fresh 404 instead. Idempotent for non-HTML responses.
 *
 * Also stops Cloudflare from edge-caching HTML responses (see header
 * comment) so the next deploy isn't masked by a stale edge HTML.
 */
export function rejectStaleAssetFallback(
  req: Request,
  res: Response,
): Response {
  const ct = res.headers.get("content-type") ?? ""

  if (res.status === 200 && ct.startsWith("text/html")) {
    const url = new URL(req.url)
    if (ASSET_EXT.test(url.pathname)) {
      // Asset URL fell into the SPA fallback — surface the 404 cleanly.
      return new Response(`stale asset: ${url.pathname}\n`, {
        status: 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          // Don't let CF or the browser cache the 404 either — once the
          // user picks up a fresh index.html, the new hash should be
          // requested and resolve.
          "cache-control": "no-store, no-cache, must-revalidate",
        },
      })
    }
    // HTML response (the SPA shell). Tell CF + the browser to not cache
    // it across redeploys. Without this, the edge serves the OLD
    // index.html (with stale asset hashes) until the cache TTL expires.
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: rewriteHtmlCacheHeaders(res.headers),
    })
  }

  return res
}

/** How long Cloudflare may edge-cache the SPA shell HTML.
 *
 *  Tradeoff:
 *  - `no-store`: every request hits the Worker — wasteful but always fresh.
 *  - long TTL: great perf, but stale HTML after a deploy points at
 *    asset hashes that no longer exist → 404 chain (caught by
 *    `rejectStaleAssetFallback`, which forces a hard-reload, but that's
 *    a bad UX if it persists).
 *  - 60s (chosen): users on a fresh load between deploys get the cache
 *    hit; the post-deploy stale window is at most a minute. If a
 *    visitor is caught in that window, asset-fallback returns 404 and
 *    the browser hard-reloads.
 *
 *  If a deploy needs to invalidate immediately, purge the CF cache
 *  manually (dashboard → aquilla.app → Caching → Purge Everything) or
 *  add a `cache_purge`-scoped token to CI and call the purge API after
 *  `wrangler deploy`. */
const HTML_EDGE_TTL_SECONDS = 60

function rewriteHtmlCacheHeaders(src: Headers): Headers {
  const h = new Headers(src)
  // Browser: revalidate every navigation. ETag still allows 304s.
  h.set("cache-control", "public, max-age=0, must-revalidate")
  // CDN: cache for HTML_EDGE_TTL_SECONDS. cdn-cache-control overrides
  // cache-control specifically at the Cloudflare edge — without it,
  // CF would also see max-age=0 and refuse to cache.
  h.set("cdn-cache-control", `public, max-age=${HTML_EDGE_TTL_SECONDS}`)
  return h
}
