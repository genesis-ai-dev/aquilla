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

function rewriteHtmlCacheHeaders(src: Headers): Headers {
  const h = new Headers(src)
  h.set("cache-control", "no-store, no-cache, must-revalidate, max-age=0")
  // Cloudflare-specific: short-circuit edge caching for this response.
  h.set("cdn-cache-control", "no-store")
  // Belt-and-suspenders: kill Pragma + remove any Expires that survived.
  h.set("pragma", "no-cache")
  h.delete("expires")
  return h
}
