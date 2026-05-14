// Cloudflare Worker entry for apps/workspace.
//
// Workspace is AD-11's deliberate SPA exception — the only app that isn't
// task-flow-scoped. Workers Assets serves the static Vite bundle
// (assets.directory = ./dist in wrangler.toml); the Worker wraps the
// asset response with:
//
//   1. Boot-time env-binding assertion (@aquilla/errors) so a
//      misconfigured preview Worker refuses to start (AD-11 §"Environment
//      binding hygiene").
//   2. Fail-closed if ENV=preview ends up bound to a production hostname.
//   3. Baseline security headers (CSP/X-Frame-Options/etc.).
//   4. Hand-off to env.ASSETS for static serving (SPA fallback to
//      index.html for client-routed sub-paths under /w/*).

import {
  assertEnvBindings,
  assertNotPreviewInProd,
} from "@aquilla/errors/env-assertion"

interface Env extends Record<string, unknown> {
  ENV: string
  PR?: string
  ASSETS: { fetch: (req: Request) => Promise<Response> }
}

const PRODUCTION_HOSTS = new Set<string>(["aquilla.app", "www.aquilla.app"])

// CSP for the workspace SPA. Looser than login/signup/reset because the
// workspace pulls in TipTap (inline styles), Tiptap collaboration over
// WebSocket (wss:), worker-based AI models served from same-origin or
// HuggingFace CDN (https:), and PostHog telemetry. Tighten later by
// pinning the exact origins via build-time env vars.
const BASELINE_CSP =
  "default-src 'self'; " +
  "script-src 'self' 'wasm-unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https:; " +
  "media-src 'self' blob:; " +
  "connect-src 'self' https: wss:; " +
  "worker-src 'self' blob:; " +
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
    // /w/ and on any unknown sub-path (per not_found_handling).
    const assetRes = await env.ASSETS.fetch(req)
    return withSecurityHeaders(assetRes)
  },
}
