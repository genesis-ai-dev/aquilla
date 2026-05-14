// Helpers around Workers Assets' SPA-fallback behavior.
//
// Workers Assets `not_found_handling = "single-page-application"` returns
// the index.html shell on any 404. That's right for app routes (so a
// deep link like `/projects/foo/bar` still mounts the SPA), but wrong
// for `/<slug>/assets/*` requests for stale hashed bundle filenames —
// the browser sees `text/html` returned for a `.css`/`.js`/`.svg` URL
// and refuses to use it ("non CSS MIME types are not allowed in strict
// mode" / "'text/html' is not a valid JavaScript MIME type").
//
// rejectStaleAssetFallback() detects this and converts the response to
// a clean 404 so the browser hard-reloads the page (picking up the new
// index.html with the current asset hashes) instead of attempting to
// parse HTML as JS/CSS.

const ASSET_EXT = /\.(css|js|mjs|map|svg|png|jpg|jpeg|webp|woff2?|ico)$/i

/**
 * Pass an asset response through, but if the request looked like an
 * asset URL and the response came back as HTML (the SPA fallback),
 * return a fresh 404 instead. Idempotent for non-HTML responses.
 */
export function rejectStaleAssetFallback(
  req: Request,
  res: Response,
): Response {
  if (res.status !== 200) return res
  const ct = res.headers.get("content-type") ?? ""
  if (!ct.startsWith("text/html")) return res
  const url = new URL(req.url)
  if (!ASSET_EXT.test(url.pathname)) return res
  return new Response(`stale asset: ${url.pathname}\n`, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  })
}
