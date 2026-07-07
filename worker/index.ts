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
  "/case-studies/come-and-see": "/case-study.html",
  "/case-studies/biblica": "/case-study-biblica.html",
}

// Structural type avoids a @cloudflare/workers-types dependency in tests.
export interface Env {
  ASSETS: { fetch(req: Request | string): Promise<Response> }
}

// Shared invite links (/join/:token) carry the SPA's generic social meta, so in
// chats they unfurl as the app rather than an invitation. We rewrite the meta to
// invite-specific copy server-side (unfurlers don't run the SPA's JS, so the
// client-fetched invite preview never reaches them). Copy is deliberately static
// — no token or project name — so private invite targets don't leak into link
// previews. The image stays the brand OG image already baked into the HTML.
const INVITE_TITLE = "You're invited to collaborate on Aquilla"
const INVITE_DESCRIPTION =
  "Join your team's translation project on Aquilla — translators, lifted."

// Rewrite the built index.html's social-meta tags to invite copy. The markup is
// machine-generated (stable attribute order/quoting), so targeted regexes are
// safe and keep this testable without the Workers-only HTMLRewriter.
export function injectInviteMeta(html: string): string {
  return html
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${INVITE_TITLE}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${INVITE_TITLE}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${INVITE_DESCRIPTION}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${INVITE_DESCRIPTION}$2`)
    .replace(/(<title>)[^<]*(<\/title>)/, `$1${INVITE_TITLE}$2`)
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

    // Shared invite links: serve the SPA shell but rewrite its social meta so
    // the link unfurls as an invitation. Only HTML responses are rewritten;
    // hashed assets that happen to live under /join/ pass through untouched.
    if (url.pathname.startsWith("/join/")) {
      const asset = await env.ASSETS.fetch(req)
      const contentType = asset.headers.get("Content-Type") ?? ""
      if (!contentType.includes("text/html")) return asset
      const html = await asset.text()
      const res = new Response(injectInviteMeta(html), asset)
      res.headers.delete("Content-Length") // body length changed after rewrite
      return res
    }

    // Everything else: hand off to the static-asset binding.
    // Workers `not_found_handling = "single-page-application"` rewrites
    // unknown paths to index.html — React Router handles the rest.
    return env.ASSETS.fetch(req)
  },
}
