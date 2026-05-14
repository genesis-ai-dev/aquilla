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
} from "@aquilla/errors"

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

    // The workspace SPA has no `/` route — entry is via /project/:id
    // (after picking a project from /projects). A bare visit to /w or
    // /w/ would mount the SPA and immediately render nothing. Bounce to
    // /projects at the edge so users land on something useful.
    if (url.pathname === "/w" || url.pathname === "/w/") {
      // Trailing slash required: Workers Routes claims `aquilla.app/projects/*`
      // which doesn't match bare `/projects` — that'd fall to Pages.
      return withSecurityHeaders(
        Response.redirect(new URL("/projects/", url).toString(), 302),
      )
    }

    const assetRes = await env.ASSETS.fetch(req)

    // Workers Assets `not_found_handling = "single-page-application"`
    // falls back to the directory-root index.html (./dist/index.html) —
    // but our build emits to ./dist/w/, so the apex index.html doesn't
    // exist and the asset binding 404s on every deep link
    // (/w/debug, /w/project/abc, …). Re-fetch the slug's index.html as
    // the SPA-fallback so client-side React Router can take over.
    if (
      assetRes.status === 404 &&
      url.pathname.startsWith("/w/") &&
      !/\.[a-z0-9]+$/i.test(url.pathname)
    ) {
      const fallback = new Request(new URL("/w/", url).toString(), req)
      const fallbackRes = await env.ASSETS.fetch(fallback)
      if (fallbackRes.ok) {
        return withSecurityHeaders(fallbackRes)
      }
    }

    return withSecurityHeaders(assetRes)
  },
}
