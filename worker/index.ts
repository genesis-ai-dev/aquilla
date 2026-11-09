// aquilla-web Worker entry
//
// Serves the SPA on aquilla.app. The independently deployed aquilla-marketing
// Worker claims the more-specific public routes (/, /homepage, /beta,
// /bible-translation, /case-studies/*, legal pages, sitemap/robots, and /mkt/*)
// ahead of this Worker's aquilla.app/* catch-all.
//
// Request flow:
//   /privacy-policy      → 301 to /privacy (the one live policy, served by marketing)
//   /join/*, /join-org/* → SPA shell with invite social meta injected
//   /*                    → env.ASSETS.fetch(req) (SPA fallback, React Router handles it)
//
// Every response on a non-canonical host (dev.aquilla.app, *.workers.dev)
// additionally carries X-Robots-Tag: noindex.
//
// Every response also carries the security headers from ./security-headers.
//
// See docs/superpowers/specs/2026-05-30-bare-domain-routing-design.md
//     docs/superpowers/specs/2026-06-22-homepage-beta-strip-and-page-design.md
//     docs/OPSEC-REVIEW-2026-08-10.md (OPS-1 — why the CSP is split
//       enforced/report-only)

import { isLocalHost, withSecurityHeaders } from "./security-headers"

// Structural type avoids a @cloudflare/workers-types dependency in tests.
export interface Env {
  ASSETS: { fetch(req: Request | string): Promise<Response> }
}

// Shared invite links (/join/:token, /join-org/:token) carry the SPA's generic
// social meta, so in chats they unfurl as the app rather than an invitation. We
// rewrite the meta to invite-specific copy server-side (unfurlers don't run the
// SPA's JS, so the client-fetched invite preview never reaches them). Copy and
// image are deliberately static — no token, project, org, or inviter name — so
// private invite targets don't leak into link previews (AQU-471).
const INVITE_TITLE = "You're invited to collaborate on Aquilla"
const INVITE_DESCRIPTION =
  "Join your team's translation project on Aquilla — translators, lifted."
// Same 1200×630 as the brand OG image, so the baked og:image:width/height tags
// stay truthful after the rewrite.
const INVITE_OG_IMAGE = "/aquilla-invite-og-1200x630.png"

// Rewrite the built index.html's social-meta tags to invite copy. The markup is
// machine-generated (stable attribute order/quoting), so targeted regexes are
// safe and keep this testable without the Workers-only HTMLRewriter.
export function injectInviteMeta(html: string, origin: string): string {
  const image = `${origin}${INVITE_OG_IMAGE}`
  return html
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${INVITE_TITLE}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${INVITE_TITLE}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${INVITE_DESCRIPTION}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${INVITE_DESCRIPTION}$2`)
    .replace(/(<meta property="og:image" content=")[^"]*(")/, `$1${image}$2`)
    .replace(/(<meta name="twitter:image" content=")[^"]*(")/, `$1${image}$2`)
    .replace(/(<meta property="og:image:alt" content=")[^"]*(")/, `$1${INVITE_TITLE}$2`)
    .replace(/(<meta name="twitter:image:alt" content=")[^"]*(")/, `$1${INVITE_TITLE}$2`)
    .replace(/(<title>)[^<]*(<\/title>)/, `$1${INVITE_TITLE}$2`)
}

// SEO: only the production host may be indexed. dev.aquilla.app and the
// *.workers.dev preview serve identical content and would otherwise compete
// with (or leak ahead of) aquilla.app in search results.
const CANONICAL_HOST = "aquilla.app"

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const res = await route(req, env)
    const host = new URL(req.url).hostname
    // withSecurityHeaders already clones (asset-binding responses have
    // immutable headers), so X-Robots-Tag rides along on the same clone.
    const wrapped = withSecurityHeaders(res, host)
    if (host !== CANONICAL_HOST && !isLocalHost(host)) {
      wrapped.headers.set("X-Robots-Tag", "noindex")
    }
    return wrapped
  },
}

// Known SPA route patterns. Paths matching these should get the SPA shell with
// a 200. Everything else gets a real 404. This fixes the soft-404 SEO issue
// where crawlers see 200 for nonexistent paths (docs/specs/2026-07-31-marketing-app-namespace-design.md
// lines 96-97, 182).
//
// Derived from src/App.tsx route table. Update this list when app routes change.
const SPA_ROUTE_PATTERNS = [
  "/",
  "/app",
  "/onboarding",
  "/login",
  "/signup",
  "/reset-password",
  "/verify-email",
  "/connect-agent",
  "/oauth/consent",
  "/oauth/callback",
  "/projects",
  "/shared",
  "/preferences",
  "/billing/select",
  "/admin",
  "/debug",
  "/this-computer",
  "/paratext",
  // Parametric routes
  /^\/join\//,
  /^\/join-org\//,
  /^\/check\//,
  /^\/link\//,
  /^\/approve\//,
  /^\/projects\//,
  /^\/project\//,
  /^\/orgs\//,
  /^\/preferences\//,
  /^\/billing\//,
  /^\/paratext\//,
  // Dev/marketing routes
  /^\/__dev\//,
  /^\/__marketing\//,
]

function isKnownSpaRoute(pathname: string): boolean {
  return SPA_ROUTE_PATTERNS.some(pattern => {
    if (typeof pattern === "string") {
      return pathname === pattern
    }
    return pattern.test(pathname)
  })
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url)

  // AQU-2243: /privacy-policy was an in-app SPA route holding a second, stale
  // copy of the policy. It is gone, and the one live policy lives at /privacy
  // (the marketing Worker's route). Nothing claims /privacy-policy ahead of
  // this catch-all, so without this the SPA fallback answered it with the
  // shell and React Router rendered "404: Not Found" — the address people have
  // bookmarked and that older copy linked to. Permanent, so crawlers and
  // browsers forget it.
  if (url.pathname === "/privacy-policy" || url.pathname === "/privacy-policy/") {
    return Response.redirect(`${url.origin}/privacy${url.search}`, 301)
  }

  // Shared invite links (project AND org — AQU-471): serve the SPA shell but
  // rewrite its social meta so the link unfurls as an invitation. Only HTML
  // responses are rewritten; hashed assets under these paths pass through.
  if (url.pathname.startsWith("/join/") || url.pathname.startsWith("/join-org/")) {
    const asset = await env.ASSETS.fetch(req)
    const contentType = asset.headers.get("Content-Type") ?? ""
    if (!contentType.includes("text/html")) return asset
    const html = await asset.text()
    const res = new Response(injectInviteMeta(html, url.origin), asset)
    res.headers.delete("Content-Length") // body length changed after rewrite
    return res
  }

  // Hashed build output (AQU-1405). The SPA fallback rewrites *any* unknown
  // path to index.html with a 200, so a chunk from a replaced build answers
  // with HTML: the browser then fails the module load with an opaque parse
  // error and caches an HTML body under a .js URL. Answer an honest 404
  // instead, which is what a missing asset is — the tab's own recovery
  // (src/lib/chunk-reload.ts) takes it from there.
  if (url.pathname.startsWith("/assets/")) {
    const asset = await env.ASSETS.fetch(req)
    const contentType = asset.headers.get("Content-Type") ?? ""
    if (!asset.ok || !contentType.includes("text/html")) return asset
    return new Response("Asset not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    })
  }

  // Soft-404 fix: check if this path is a known SPA route. Unknown paths
  // get a real 404 instead of the SPA shell with a 200, fixing the SEO issue
  // where Google treats unknown paths returning 200 as soft-404s.
  if (!isKnownSpaRoute(url.pathname)) {
    return new Response("Page not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    })
  }

  // Known SPA routes: hand off to the static-asset binding.
  // Workers `not_found_handling = "single-page-application"` rewrites
  // these to index.html — React Router handles the rest.
  return env.ASSETS.fetch(req)
}
