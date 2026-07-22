// Same-origin resource proxy — the CLIENT half (AQU-627).
//
// Rewrites the SPA's third-party CONTENT fetches so they name our own domain
// instead of a meaningful upstream host (Door43/DCS, helloao, eBible). See
// ./resource-proxy-handler.ts for the Worker that serves the rewritten URLs and
// the rationale.
//
// Controlled entirely by the build-time `VITE_RESOURCES_BASE` env var:
//   - UNSET (default, incl. every existing test + today's prod build) → these
//     helpers are transparent no-ops and fetches go direct, exactly as before.
//   - set to e.g. `https://resources.aquilla.app` → allow-listed content hosts
//     are rewritten to `https://resources.aquilla.app/<host>/<path>`.
//
// Wiring a fetch through here is done by deriving its base URL from
// `proxyOrigin()`; unknown hosts and the no-base case pass through untouched,
// so the change is safe to land before the Worker/subdomain exists.

import { isProxyableHost } from "./resource-proxy-handler"

export { EXTERNAL_CONTENT_HOSTS, isProxyableHost } from "./resource-proxy-handler"

/** The proxy base, e.g. `https://resources.aquilla.app`, or "" when unset.
 *  Trailing slashes are trimmed so callers can always append `/...`. */
export function getResourcesBase(): string {
  return (
    (import.meta.env.VITE_RESOURCES_BASE as string | undefined)?.replace(/\/+$/, "") ?? ""
  )
}

/**
 * Rewrite a same-scheme ORIGIN (`https://host`, no trailing slash) to its
 * proxied form so callers can build base URLs from it:
 *
 *   proxyOrigin("https://git.door43.org")           // proxy off → unchanged
 *   proxyOrigin("https://git.door43.org")            // proxy on  → "https://resources.aquilla.app/git.door43.org"
 *
 * Returns the origin untouched when the proxy is unconfigured or the host isn't
 * on the content allow-list, so it's always safe to wrap a base URL.
 */
export function proxyOrigin(origin: string): string {
  const base = getResourcesBase()
  if (!base) return origin
  let host: string
  try {
    host = new URL(origin).host
  } catch {
    return origin
  }
  if (!isProxyableHost(host)) return origin
  return `${base}/${host}`
}

/**
 * Rewrite a full resource URL to its proxied form. Preserves path, query and
 * hash. Same passthrough guarantees as {@link proxyOrigin}. Useful for ad-hoc
 * fetches that don't go through a shared base-URL constant.
 */
export function proxyResourceUrl(rawUrl: string): string {
  const base = getResourcesBase()
  if (!base) return rawUrl
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return rawUrl
  }
  if (!isProxyableHost(url.host)) return rawUrl
  return `${base}/${url.host}${url.pathname}${url.search}${url.hash}`
}

/** `fetch` that transparently routes allow-listed content hosts through the
 *  proxy. A drop-in for `fetch(url, init)` at string-URL call sites. */
export function proxiedFetch(
  input: string,
  init?: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  return fetchImpl(proxyResourceUrl(input), init)
}
