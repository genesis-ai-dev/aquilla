// aquilla-web Worker entry
//
// Routes requests on aquilla.app to either the SPA (index.html) or the
// static placeholder homepage (homepage.html) based on the presence of the
// aq_hint=1 cookie — a non-credential, host-only 1-bit cookie written by the
// SPA's session-store whenever there is an active IDB session.
//
// Request flow:
//   /homepage          → always serve homepage.html (bypass for QA / sharing)
//   /  (no aq_hint)   → serve homepage.html  (signed-out visitor)
//   /  (aq_hint=1)    → serve index.html      (signed-in user)
//   /* (anything else) → env.ASSETS.fetch(req) (SPA fallback, React Router handles it)
//
// See docs/superpowers/specs/2026-05-30-bare-domain-routing-design.md

// Structural type avoids a @cloudflare/workers-types dependency in tests.
export interface Env {
  ASSETS: { fetch(req: Request | string): Promise<Response> }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    // Bypass: always show the homepage regardless of hint state.
    if (url.pathname === "/homepage") {
      const target = new URL("/homepage.html", req.url)
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
