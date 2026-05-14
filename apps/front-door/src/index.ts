// Front-door Worker for the Aquilla monorepo.
//
// Per AD-11 / spec §21-monorepo.md, the front-door handles ONLY:
//   GET /          → 302 redirect to /projects
//   GET /__routes  → JSON dump of routes.json (debug aid)
//   anything else  → 404 (Workers Routes claims real app paths upstream)
//
// It is intentionally NOT a dispatcher: Workers Routes maps
// `aquilla.app/<slug>/*` directly to the `aquilla-<slug>` Worker without
// going through here, so adding a new app does not require a front-door
// redeploy (only a routes.json edit + redeploy when you want the debug
// list to reflect it).
//
// Build-time `routes.json` is imported via the bundler so the deploy
// artifact is self-contained — no fetch at request time.

import routesJson from "../../../routes.json"
import { assertEnvBindings, assertNotPreviewInProd } from "@aquilla/errors/env-assertion"

type Routes = Record<string, string>
const routes = routesJson as Routes

// The default landing app. Lives in `routes.json` so it stays consistent
// with the rest of the registry. Trailing slash is required: Workers
// Routes patterns use `aquilla.app/<slug>/*` which does NOT match the
// bare `/<slug>` path, so the redirect target has to include the slash
// or it falls through to Pages and renders the wrong app.
const DEFAULT_APP_PATH =
  ((routes.projects ?? "/projects") + "/").replace(/\/+$/, "/")

const PRODUCTION_HOSTS = new Set<string>(["aquilla.app", "www.aquilla.app"])

interface Env {
  ENV: string
  PR?: string
}

// CSP applied uniformly to every front-door response. Per AD-11 the
// front-door is the canonical home for cross-cutting edge concerns like
// CSP — apps inherit nothing from here at runtime; this header simply
// covers the surfaces the front-door itself serves (the root redirect,
// /__routes, and 404 fallbacks).
const BASELINE_CSP =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "connect-src 'self'; " +
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
    // Boot-time hygiene (AD-11; spec §"Environment binding hygiene").
    // Re-runs cheaply per request — Workers don't have a real "boot"
    // hook, and getting this wrong is exactly the kind of mistake that
    // bites in prod, so we pay the few microseconds per request.
    assertEnvBindings(env, env.ENV)

    const url = new URL(req.url)

    // Production-domain fail-closed: refuse to serve a preview Worker on
    // the production hostname.
    if (PRODUCTION_HOSTS.has(url.hostname)) {
      assertNotPreviewInProd(env, url.hostname)
    }

    // Root → default app.
    if (url.pathname === "/" || url.pathname === "") {
      return withSecurityHeaders(
        Response.redirect(new URL(DEFAULT_APP_PATH, url).toString(), 302),
      )
    }

    // Debug: dump the routes registry as JSON.
    if (url.pathname === "/__routes") {
      return withSecurityHeaders(
        new Response(JSON.stringify(routes, null, 2), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        }),
      )
    }

    // Anything else falls through to 404. Real app paths get claimed by
    // more-specific Workers Routes patterns upstream of this Worker and
    // never reach here.
    return withSecurityHeaders(
      new Response(`Not found: ${url.pathname}\n`, {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    )
  },
}
