// Cloudflare Worker entry for apps/login.
//
// Workers Assets serves the static Vite bundle (`assets.directory =
// ./dist` in wrangler.toml). The Worker script itself stays minimal:
//
//   1. Run the boot-time env-binding assertion from @aquilla/errors so a
//      misconfigured preview Worker refuses to start (AD-11 §"Environment
//      binding hygiene").
//   2. Fail closed if ENV=preview ends up bound to the production
//      hostname.
//   3. Apply baseline security headers.
//   4. Hand the request off to env.ASSETS for static serving (with SPA
//      fallback to index.html — Vite emits a single SPA bundle).

import {
  assertEnvBindings,
  assertNotPreviewInProd,
} from "@aquilla/errors/env-assertion"
import { rejectStaleAssetFallback } from "@aquilla/errors/asset-fallback"
import { THEME_BOOTSTRAP_INLINE_SCRIPT_SHA256 } from "@aquilla/errors/theme-bootstrap-csp"

// EnvLike is `Record<string, unknown>` — extending it keeps the
// assertEnvBindings() helper type-compatible without an explicit cast.
interface Env extends Record<string, unknown> {
  ENV: string
  PR?: string
  ASSETS: { fetch: (req: Request) => Promise<Response> }
}

const PRODUCTION_HOSTS = new Set<string>(["aquilla.app", "www.aquilla.app"])

const BASELINE_CSP =
  "default-src 'self'; " +
  `script-src 'self' ${THEME_BOOTSTRAP_INLINE_SCRIPT_SHA256}; ` +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  // The auth-worker host is provided at build time via VITE_AUTH_BASE; we
  // don't know the value here, so connect-src stays permissive enough to
  // hit any https origin. Tighten later by reading the value at build
  // time and inlining it via the Worker bundler (`wrangler.toml` vars).
  "connect-src 'self' https: wss:; " +
  "frame-ancestors 'none'; " +
  "base-uri 'self'; " +
  "form-action 'self'"

function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers)
  headers.set("Content-Security-Policy", BASELINE_CSP)
  headers.set("X-Content-Type-Options", "nosniff")
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin")
  headers.set("X-Frame-Options", "DENY")
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  })
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    assertEnvBindings(env, env.ENV)

    const url = new URL(req.url)
    if (PRODUCTION_HOSTS.has(url.hostname)) {
      assertNotPreviewInProd(env, url.hostname)
    }

    // Hand to Workers Assets. The asset binding handles SPA fallback +
    // immutable hashing for hashed file names; index.html is served at
    // /login/ and on any unknown sub-path. `rejectStaleAssetFallback`
    // converts the SPA-fallback HTML to a clean 404 when an asset-shaped
    // path (stale hashed bundle) hits the fallback.
    const assetRes = rejectStaleAssetFallback(req, await env.ASSETS.fetch(req))
    return withSecurityHeaders(assetRes)
  },
}
