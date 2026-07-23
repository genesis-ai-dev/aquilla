// aquilla-resources — same-origin content proxy Worker (AQU-627).
//
// Serves rewritten third-party CONTENT fetches from a subdomain of our own
// domain (resources.aquilla.app) so a translator's network only ever sees
// `*.aquilla.app` in DNS/SNI — never git.door43.org, bible.helloao.org, etc.
// The SPA rewrites its base URLs to point here when built with
// VITE_RESOURCES_BASE=https://resources.aquilla.app (see
// src/lib/net/resource-proxy.ts).
//
// All request-handling logic lives in the shared, dependency-free handler so it
// is unit-tested in the root vitest suite (src/lib/net/resource-proxy.test.ts).
// This entry is just the Cloudflare glue + a CORS preflight responder.
//
// NOT YET DEPLOYED — see resource-worker/README.md for the out-of-band route +
// security-review checklist that gates turning this on.

import { proxyResourceRequest } from "../src/lib/net/resource-proxy-handler"

const CORS_PREFLIGHT_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  // Conditional/ranged GETs use non-safelisted request headers, which trigger a
  // preflight; allow them so caching keeps working cross-subdomain.
  "access-control-allow-headers": "range, if-none-match, if-modified-since",
  "access-control-max-age": "86400",
}

export default {
  fetch(request: Request): Promise<Response> | Response {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS })
    }
    return proxyResourceRequest(request)
  },
}
