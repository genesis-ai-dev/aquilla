// aquilla-web Worker entry
//
// Routes requests on aquilla.app to either the SPA (index.html) or one of the
// static marketing pages (homepage.html, beta.html) based on the presence of
// the aq_hint=1 cookie — a non-credential, host-only 1-bit cookie written by
// the SPA's session-store whenever there is an active IDB session.
//
// Request flow:
//   <static page>      → always serve its .html (bypass for QA / sharing / SEO)
//   /  (no aq_hint)   → serve homepage.html  (signed-out visitor)
//   /  (aq_hint=1)    → serve index.html      (signed-in user)
//   /* (anything else) → env.ASSETS.fetch(req) (SPA fallback, React Router handles it)
//
// Marketing pages are statically-served, standalone HTML documents (their own
// build entry + this route). Adding one = a vite input + a STATIC_PAGES line.
//
// See docs/superpowers/specs/2026-05-30-bare-domain-routing-design.md
//     docs/superpowers/specs/2026-06-22-homepage-beta-strip-and-page-design.md

// Standalone marketing pages: request path → static asset to serve. Each
// bypasses the aq_hint cookie check so it's shareable and crawlable regardless
// of session state.
const STATIC_PAGES: Record<string, string> = {
  "/homepage": "/homepage.html",
  "/beta": "/beta.html",
}

// Structural type avoids a @cloudflare/workers-types dependency in tests.
export interface Env {
  ASSETS: { fetch(req: Request | string): Promise<Response> }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    // Bypass: always show a static marketing page regardless of hint state.
    const staticTarget = STATIC_PAGES[url.pathname]
    if (staticTarget) {
      const target = new URL(staticTarget, req.url)
      return env.ASSETS.fetch(target.toString())
    }

    // Root: serve SPA or homepage based on the auth hint cookie.
    // Must not be CDN-cached (response depends on Cookie header).
    if (url.pathname === "/") {
      const cookie = req.headers.get("Cookie") ?? ""
      const signedIn = /(?:^|;\s*)aq_hint=1(?:;|$)/.test(cookie)
      const target = new URL(signedIn ? "/index.html" : "/homepage.html", req.url)
      const asset = await env.ASSETS.fetch(target.toString())
      const res = new Response(asset.body, asset)
      res.headers.set("Cache-Control", "private, no-store")
      return res
    }

    // Everything else: hand off to the static-asset binding.
    // Workers `not_found_handling = "single-page-application"` rewrites
    // unknown paths to index.html — React Router handles the rest.
    return env.ASSETS.fetch(req)
  },
}
