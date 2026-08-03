// aquilla-web Worker entry
//
// Routes requests on aquilla.app to either one of the static marketing pages
// (homepage.html, beta.html, …) or the SPA (index.html). The root is the
// marketing homepage for everyone — identity is resolved in the browser
// (AppEntryBanner), not here, so `/` stays edge-cacheable.
//
// Request flow:
//   <static page>      → always serve its .html (bypass for QA / sharing / SEO)
//   /                  → serve homepage.html (everyone; shared-cached)
//   /* (anything else) → env.ASSETS.fetch(req) (SPA fallback, React Router handles it)
//
// Every response on a non-canonical host (dev.aquilla.app, *.workers.dev)
// additionally carries X-Robots-Tag: noindex.
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
  "/bible-translation": "/bible-translation.html",
  "/beta": "/beta.html",
  "/case-studies/come-and-see": "/case-study.html",
  "/case-studies/biblica": "/case-study-biblica.html",
}

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
    if (host !== CANONICAL_HOST && host !== "localhost" && !host.endsWith(".localhost")) {
      const wrapped = new Response(res.body, res)
      wrapped.headers.set("X-Robots-Tag", "noindex")
      return wrapped
    }
    return res
  },
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url)

  // Bypass: always show a static marketing page regardless of hint state.
  const staticTarget = STATIC_PAGES[url.pathname]
  if (staticTarget) {
    const target = new URL(staticTarget, req.url)
    return env.ASSETS.fetch(target.toString())
  }

  // Root: always the marketing homepage, for everyone.
  //
  // This used to branch on the aq_hint cookie and serve the SPA to signed-in
  // users. Three reasons it doesn't any more:
  //
  //  1. It never actually worked. Cloudflare's asset router resolves `/` to
  //     index.html before the Worker runs, so the branch never executed and
  //     the bare domain served the empty app shell to everyone, crawlers
  //     included. `run_worker_first = ["/"]` in wrangler.toml is what makes
  //     this handler reachable at all.
  //  2. A Cookie-dependent root can never be edge-cached — it forced
  //     `private, no-store` on the most-requested URL we have.
  //  3. It isn't what comparable products do. linear.app and cursor.com both
  //     serve one shared-cached marketing page at `/` and neither varies on
  //     Cookie.
  //
  // Identity is now resolved in the browser instead: AppEntryBanner reads the
  // session from IndexedDB after mount and offers signed-in visitors a way
  // into the workspace at /app. That keeps this response identical for every
  // visitor, so it caches.
  if (url.pathname === "/") {
    const target = new URL("/homepage.html", req.url)
    const asset = await env.ASSETS.fetch(target.toString())
    const res = new Response(asset.body, asset)
    // Revalidate per browser request, cache at the edge, and keep serving
    // stale while revalidating so a deploy never leaves visitors waiting.
    res.headers.set("Cache-Control", "public, max-age=0, s-maxage=600, stale-while-revalidate=86400")
    return res
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

  // Everything else: hand off to the static-asset binding.
  // Workers `not_found_handling = "single-page-application"` rewrites
  // unknown paths to index.html — React Router handles the rest.
  return env.ASSETS.fetch(req)
}
