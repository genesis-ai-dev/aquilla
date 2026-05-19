// Front-door Worker for the Aquilla monorepo.
//
// Per AD-11 / spec §21-monorepo.md, the front-door owns ONLY:
//   GET /                 → 302 redirect to /projects/
//   GET /__routes         → JSON dump of routes.json (debug aid)
//   GET /<slug>           → 301 to /<slug>/ for every entry in routes.json
//                           (Workers Routes pattern `aquilla.app/<slug>/*`
//                           does NOT match the bare slug; without these
//                           redirects, the workspace SPA fallback used to
//                           render at the wrong path)
//   GET /project/*        → 301 to /w/project/* (legacy workspace URL)
//   GET /debug, /debug/*  → 301 to /w/debug, /w/debug/* (ditto)
//   GET /join/*           → 301 to /w/join/* (share-link entry)
//   GET /settings/*       → 301 to /w/settings/* (legacy workspace URL)
//   anything else         → 404 (Workers Routes claims real app paths
//                                upstream of this Worker)
//
// The redirect rules replace what `public/_redirects` used to do at the
// Pages layer; this is part of the AD-11 spec-unification step that
// retires Cloudflare Pages in favor of pure Workers Routes.
//
// It is intentionally NOT a dispatcher: Workers Routes maps
// `aquilla.app/<slug>/*` directly to the `aquilla-<slug>` Worker without
// going through here, so adding a new app does not require a front-door
// redeploy (only a routes.json edit + redeploy when you want the debug
// list and bare-slug redirect map to reflect it).
//
// Build-time `routes.json` is imported via the bundler so the deploy
// artifact is self-contained — no fetch at request time.

import routesJson from "../../../routes.json"
import { assertEnvBindings, assertNotPreviewInProd } from "@aquilla/errors/env-assertion"
import { THEME_BOOTSTRAP_INLINE_SCRIPT_SHA256 } from "@aquilla/errors/theme-bootstrap-csp"

type Routes = Record<string, string>
const routes = routesJson as Routes

// The default landing app. Lives in `routes.json` so it stays consistent
// with the rest of the registry. Trailing slash is required: Workers
// Routes patterns use `aquilla.app/<slug>/*` which does NOT match the
// bare `/<slug>` path, so the redirect target has to include the slash
// or it falls through to Pages and renders the wrong app.
const DEFAULT_APP_PATH =
  ((routes.projects ?? "/projects") + "/").replace(/\/+$/, "/")

// Bare slug → trailing-slash redirect map. e.g. /login → /login/.
// Workers Routes pattern `aquilla.app/login/*` would otherwise miss the
// bare `/login` request and fall through to the catch-all 404 (or, while
// Pages is still up, to the legacy SPA fallback that doesn't know about
// these slugs and renders blank). Built from routes.json so adding an
// app picks up its bare-slug redirect for free.
const BARE_SLUG_REDIRECTS: Record<string, string> = Object.fromEntries(
  Object.entries(routes)
    // Only the simple `/<slug>` mounts — multi-segment mounts like
    // `/api/identity` don't have the bare-slug problem and don't need
    // a redirect.
    .filter(([, path]) => /^\/[a-z0-9-]+$/.test(path))
    .map(([, path]) => [path, path + "/"] as const),
)

// Legacy workspace-bundle URLs (served by Pages before the AD-11
// cutover). These now redirect into apps/workspace/ at `/w/<path>`. The
// workspace's React Router has `basename="/w"` so its internal route
// tree resolves identically once the path is reached.
const LEGACY_WORKSPACE_PREFIXES = [
  "/project/",
  "/debug",
  "/join/",
  "/settings/",
]

function legacyWorkspaceRedirect(pathname: string): string | null {
  for (const prefix of LEGACY_WORKSPACE_PREFIXES) {
    if (pathname === prefix.replace(/\/$/, "") || pathname.startsWith(prefix)) {
      return "/w" + pathname
    }
  }
  return null
}

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
  `script-src 'self' ${THEME_BOOTSTRAP_INLINE_SCRIPT_SHA256}; ` +
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

    // Bare slug → trailing-slash. e.g. /login → /login/.
    const bareSlugTarget = BARE_SLUG_REDIRECTS[url.pathname]
    if (bareSlugTarget) {
      const target = new URL(bareSlugTarget, url)
      target.search = url.search
      return withSecurityHeaders(Response.redirect(target.toString(), 301))
    }

    // Legacy workspace URLs that used to be served by Pages. Redirect
    // into apps/workspace/ at /w/<path>.
    const legacyTarget = legacyWorkspaceRedirect(url.pathname)
    if (legacyTarget) {
      const target = new URL(legacyTarget, url)
      target.search = url.search
      return withSecurityHeaders(Response.redirect(target.toString(), 301))
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
