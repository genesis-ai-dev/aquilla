import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it, expect } from "vitest"
import "./index"

// A trimmed copy of the built index.html social-meta block, used to assert the
// invite-link rewrite hits the real markup shape.
const SPA_HTML = `<!doctype html><html><head>
  <title>Aquilla</title>
  <meta property="og:title" content="Aquilla" />
  <meta property="og:description" content="Aquilla — translators, lifted." />
  <meta property="og:image" content="https://aquilla.app/aquilla-og-1200x630.png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="Aquilla — translators, lifted." />
  <meta name="twitter:image" content="https://aquilla.app/aquilla-og-1200x630.png" />
  <meta name="twitter:image:alt" content="Aquilla — translators, lifted." />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="Aquilla" />
  <meta name="twitter:description" content="Aquilla — translators, lifted." />
</head><body></body></html>`

// Minimal mock for the ASSETS binding: returns a Response whose body is the
// resolved pathname so tests can assert which file was requested. Mimics the
// real Workers asset binding: known app routes and unknown paths get index.html
// with the SPA marker (not_found_handling = "single-page-application"), while
// unknown paths would get the shell in production.
//
// Known SPA routes that get the shell (matches SPA_ROUTE_PATTERNS):
const MOCK_SPA_ROUTES = [
  "/",
  "/app",
  "/login",
  "/signup",
  "/onboarding",
  "/projects",
  "/shared",
  "/preferences",
  "/admin",
  "/debug",
  "/oauth/consent",
  "/oauth/callback",
  /^\/orgs\//,
  /^\/project\//,
  /^\/__dev\//,
]

function isMockSpaRoute(pathname: string): boolean {
  const normalized = pathname === "/" ? "/" : pathname.replace(/\/$/, "")
  return MOCK_SPA_ROUTES.some(pattern => {
    if (typeof pattern === "string") return normalized === pattern
    return pattern.test(normalized)
  })
}

function makeEnv() {
  return {
    ASSETS: {
      fetch: async (req: Request | string): Promise<Response> => {
        const url = new URL(typeof req === "string" ? req : req.url)
        const pathname = url.pathname
        
        // Simulate the real asset binding: known routes and unknown paths both
        // get index.html with the marker (the Worker decides which is which).
        if (isMockSpaRoute(pathname) || pathname.startsWith("/nonexistent") || pathname.startsWith("/fake-") || pathname.startsWith("/blog/")) {
          return new Response(`<!-- This file is the APP shell -->\n<html>served:${pathname}</html>`, {
            status: 200,
            headers: { "Content-Type": "text/html" },
          })
        }
        
        // Marketing paths (/beta, /privacy, /terms, /bible-translation) would be
        // owned by the marketing Worker on production. On preview aliases this
        // Worker sees them, but they should 404 (not served by this Worker).
        // Return the shell so the Worker's soft-404 logic catches them.
        if (pathname === "/beta" || pathname === "/privacy" || pathname === "/terms" || pathname === "/bible-translation" || pathname === "/settings") {
          return new Response(`<!-- This file is the APP shell -->\n<html>served:${pathname}</html>`, {
            status: 200,
            headers: { "Content-Type": "text/html" },
          })
        }
        
        // Real files (images, etc.) don't have the marker
        return new Response(`served:${pathname}`, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        })
      },
    },
  }
}

async function fetchWorker(path: string, cookie?: string) {
  const { default: worker } = await import("./index")
  const headers: HeadersInit = {}
  if (cookie) headers["Cookie"] = cookie
  const req = new Request(`https://aquilla.app${path}`, { headers })
  return worker.fetch(req, makeEnv())
}

describe("worker/index — routing", () => {
  // The marketing routes belong to the aquilla-marketing Worker in production:
  // its zone routes are more specific than this Worker's aquilla.app/* catch-all.
  // When this Worker sees one on a preview alias (e.g., workers.dev), it should
  // NOT serve them as the SPA shell - they 404 since they're not in our route list.
  it("GET / passes through to ASSETS (SPA shell)", async () => {
    const res = await fetchWorker("/")
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("served:/")
    expect(body).toContain("This file is the APP shell")
  })

  it("GET /beta returns 404 (marketing route, not owned by this Worker)", async () => {
    const res = await fetchWorker("/beta")
    expect(res.status).toBe(404)
    expect(await res.text()).toBe("Page not found")
  })

  it("GET /project/abc passes through to ASSETS unchanged", async () => {
    const res = await fetchWorker("/project/abc")
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("served:/project/abc")
    expect(body).toContain("This file is the APP shell")
  })

  // /app is the stable entry target linked by the separate marketing site.
  it("GET /app passes through to ASSETS (SPA shell)", async () => {
    const res = await fetchWorker("/app")
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("served:/app")
    expect(body).toContain("This file is the APP shell")
  })

  it("GET /app is served the SPA shell even when signed in (aq_hint=1)", async () => {
    const res = await fetchWorker("/app", "aq_hint=1")
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("served:/app")
    expect(body).toContain("This file is the APP shell")
  })

  // AQU-795 / AQU-719 regression guard: a previously Google-indexed interior URL
  // must resolve to the SPA shell (not_found_handling = single-page-application
  // rewrites it to index.html) so React Router opens the page directly — never
  // bounced to marketing and never the old "page not found until you navigate
  // from home" symptom. Marketing routes never reach this Worker on the live
  // custom domains because their more-specific Worker routes win first.
  //
  // Note: /settings is NOT a top-level route in current App.tsx (settings live
  // under /orgs/:orgId/settings), so it correctly gets a 404. This is proper SEO
  // behavior for a path with no React route.
  it("GET interior deep links pass through to ASSETS (SPA shell), not marketing", async () => {
    for (const path of ["/orgs/abc", "/project/abc/editor", "/shared"]) {
      const res = await fetchWorker(path)
      expect(res.status, `${path} should return 200`).toBe(200)
      expect(await res.text(), `${path} must reach the SPA shell`).toContain(`served:${path}`)
    }
  })

  it("GET /settings returns 404 (no top-level /settings route in App.tsx)", async () => {
    const res = await fetchWorker("/settings")
    expect(res.status).toBe(404)
    expect(await res.text()).toBe("Page not found")
  })

  it("GET /join/xyz passes through to ASSETS (SPA shell for invite routes)", async () => {
    const res = await fetchWorker("/join/xyz")
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("served:/join/xyz")
    expect(body).toContain("This file is the APP shell")
  })

  it("GET /join/:token rewrites social meta to invite copy when ASSETS returns HTML", async () => {
    const { default: worker } = await import("./index")
    const env = {
      ASSETS: {
        fetch: async (): Promise<Response> =>
          new Response(SPA_HTML, { status: 200, headers: { "Content-Type": "text/html" } }),
      },
    }
    const res = await worker.fetch(new Request("https://aquilla.app/join/abc123"), env)
    const html = await res.text()
    expect(html).toContain(`<meta property="og:title" content="You're invited to collaborate on Aquilla" />`)
    expect(html).toContain(`<meta name="twitter:title" content="You're invited to collaborate on Aquilla" />`)
    expect(html).toContain(`<title>You're invited to collaborate on Aquilla</title>`)
    expect(html).toContain(`content="Join your team's translation project on Aquilla — translators, lifted."`)
    // AQU-471: unfurl image swaps to the dedicated invite OG image (generic by
    // design — no org/project/inviter names leak to link scrapers).
    expect(html).toContain(`<meta property="og:image" content="https://aquilla.app/aquilla-invite-og-1200x630.png" />`)
    expect(html).toContain(`<meta name="twitter:image" content="https://aquilla.app/aquilla-invite-og-1200x630.png" />`)
    expect(html).toContain(`<meta property="og:image:alt" content="You're invited to collaborate on Aquilla" />`)
    expect(html).not.toContain("aquilla-og-1200x630.png")
  })

  it("GET /join-org/:token rewrites social meta the same way (AQU-471)", async () => {
    const { default: worker } = await import("./index")
    const env = {
      ASSETS: {
        fetch: async (): Promise<Response> =>
          new Response(SPA_HTML, { status: 200, headers: { "Content-Type": "text/html" } }),
      },
    }
    const res = await worker.fetch(new Request("https://aquilla.app/join-org/abc123"), env)
    const html = await res.text()
    expect(html).toContain(`<title>You're invited to collaborate on Aquilla</title>`)
    expect(html).toContain(`<meta property="og:image" content="https://aquilla.app/aquilla-invite-og-1200x630.png" />`)
  })

  it("GET /join/:token leaves a non-HTML asset (e.g. hashed JS) untouched", async () => {
    const { default: worker } = await import("./index")
    const env = {
      ASSETS: {
        fetch: async (): Promise<Response> =>
          new Response("console.log(1)", {
            status: 200,
            headers: { "Content-Type": "application/javascript" },
          }),
      },
    }
    const res = await worker.fetch(new Request("https://aquilla.app/join/app.js"), env)
    expect(await res.text()).toBe("console.log(1)")
  })

  // AQU-2243: the in-app /privacy-policy route held a second, stale copy of the
  // policy and the live one is /privacy (the marketing Worker's route). With the
  // route gone, the SPA fallback would answer the old address with the shell and
  // React Router would render "404: Not Found" — so the Worker redirects it.
  it("GET /privacy-policy 301s to /privacy instead of reaching the SPA", async () => {
    const res = await fetchWorker("/privacy-policy")
    expect(res.status).toBe(301)
    expect(res.headers.get("Location")).toBe("https://aquilla.app/privacy")
  })

  it("GET /privacy-policy/ (trailing slash) 301s the same way", async () => {
    const res = await fetchWorker("/privacy-policy/")
    expect(res.status).toBe(301)
    expect(res.headers.get("Location")).toBe("https://aquilla.app/privacy")
  })

  it("the /privacy-policy redirect keeps the query string and the host it was asked on", async () => {
    const { default: worker } = await import("./index")
    const res = await worker.fetch(
      new Request("https://dev.aquilla.app/privacy-policy?utm_source=onboarding"),
      makeEnv(),
    )
    expect(res.status).toBe(301)
    expect(res.headers.get("Location")).toBe("https://dev.aquilla.app/privacy?utm_source=onboarding")
  })

  // /privacy and /terms belong to the marketing Worker on the live domains.
  // On preview aliases this Worker sees them, but they're not in our route list,
  // so they correctly 404 (this Worker doesn't serve marketing pages).
  it("GET /privacy and /terms return 404 (marketing routes, not owned by this Worker)", async () => {
    for (const path of ["/privacy", "/terms"]) {
      const res = await fetchWorker(path)
      expect(res.status, path).toBe(404)
      expect(await res.text()).toBe("Page not found")
    }
  })

  it("GET /__dev/login passes through to ASSETS unchanged", async () => {
    const res = await fetchWorker("/__dev/login")
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("served:/__dev/login")
    expect(body).toContain("This file is the APP shell")
  })

  it("GET /__dev/logout passes through to ASSETS (SPA shell)", async () => {
    const res = await fetchWorker("/__dev/logout")
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("served:/__dev/logout")
    expect(body).toContain("This file is the APP shell")
  })

  // Trailing slashes on exact-match routes should still work
  it("GET /login/ (trailing slash) returns the SPA shell, not 404", async () => {
    const res = await fetchWorker("/login/")
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("This file is the APP shell")
  })

  it("GET /app/ (trailing slash) returns the SPA shell, not 404", async () => {
    const res = await fetchWorker("/app/")
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("This file is the APP shell")
  })

  it("GET /signup/ (trailing slash) returns the SPA shell, not 404", async () => {
    const res = await fetchWorker("/signup/")
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("This file is the APP shell")
  })

  // Soft-404 fix: unknown paths should return a real 404, not the SPA shell
  it("GET /nonexistent-xyz returns 404 instead of the SPA shell", async () => {
    const res = await fetchWorker("/nonexistent-xyz")
    expect(res.status).toBe(404)
    expect(res.headers.get("Content-Type")).toContain("text/plain")
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    const body = await res.text()
    expect(body).toBe("Page not found")
    expect(body).not.toContain("<html")
  })

  it("GET /fake-marketing-page returns 404 instead of the SPA shell", async () => {
    const res = await fetchWorker("/fake-marketing-page")
    expect(res.status).toBe(404)
    expect(await res.text()).toBe("Page not found")
  })

  it("GET /blog/nonexistent returns 404 instead of the SPA shell", async () => {
    const res = await fetchWorker("/blog/nonexistent")
    expect(res.status).toBe(404)
    expect(await res.text()).toBe("Page not found")
  })

  // Real static files outside /assets/ must still be served, not 404'd
  it("GET /aquilla-invite-og-1200x630.png serves the real file, not 404", async () => {
    const { default: worker } = await import("./index")
    const env = {
      ASSETS: {
        fetch: async (): Promise<Response> =>
          new Response("PNG binary data", {
            status: 200,
            headers: { "Content-Type": "image/png", "Content-Length": "12345" },
          }),
      },
    }
    const res = await worker.fetch(
      new Request("https://aquilla.app/aquilla-invite-og-1200x630.png"),
      env,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/png")
    expect(await res.text()).toBe("PNG binary data")
  })

  it("GET /favicon.svg serves the real file, not 404", async () => {
    const { default: worker } = await import("./index")
    const env = {
      ASSETS: {
        fetch: async (): Promise<Response> =>
          new Response("<svg>...</svg>", {
            status: 200,
            headers: { "Content-Type": "image/svg+xml", "Content-Length": "1234" },
          }),
      },
    }
    const res = await worker.fetch(new Request("https://aquilla.app/favicon.svg"), env)
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml")
    expect(await res.text()).toBe("<svg>...</svg>")
  })

  it("GET /google4279c85270b47b1a.html serves the real verification file, not 404 or SPA shell", async () => {
    const { default: worker } = await import("./index")
    const env = {
      ASSETS: {
        fetch: async (): Promise<Response> =>
          new Response("google-site-verification: google4279c85270b47b1a.html", {
            status: 200,
            headers: { "Content-Type": "text/html", "Content-Length": "58" },
          }),
      },
    }
    const res = await worker.fetch(
      new Request("https://aquilla.app/google4279c85270b47b1a.html"),
      env,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("text/html")
    const body = await res.text()
    expect(body).toBe("google-site-verification: google4279c85270b47b1a.html")
    expect(body).not.toContain("<!doctype html>")
  })

  it("GET /character-voices/narrator.mp3 serves the real file, not 404", async () => {
    const { default: worker } = await import("./index")
    const env = {
      ASSETS: {
        fetch: async (): Promise<Response> =>
          new Response("audio data", {
            status: 200,
            headers: { "Content-Type": "audio/mpeg", "Content-Length": "98765" },
          }),
      },
    }
    const res = await worker.fetch(
      new Request("https://aquilla.app/character-voices/narrator.mp3"),
      env,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg")
  })

  it("GET /nonexistent when ASSETS returns the SPA shell (with marker) gets 404", async () => {
    const { default: worker } = await import("./index")
    const env = {
      ASSETS: {
        fetch: async (): Promise<Response> =>
          new Response("<!-- This file is the APP shell -->\n" + SPA_HTML, {
            status: 200,
            headers: { "Content-Type": "text/html", "Content-Length": "13802" },
          }),
      },
    }
    const res = await worker.fetch(new Request("https://aquilla.app/nonexistent-path"), env)
    expect(res.status).toBe(404)
    expect(res.headers.get("Content-Type")).toContain("text/plain")
    expect(await res.text()).toBe("Page not found")
  })

  it("GET /nonexistent when ASSETS returns the SPA shell without Content-Length still gets 404", async () => {
    const { default: worker } = await import("./index")
    const env = {
      ASSETS: {
        fetch: async (): Promise<Response> =>
          new Response("<!-- This file is the APP shell -->\n" + SPA_HTML, {
            status: 200,
            headers: { "Content-Type": "text/html" },
            // No Content-Length header
          }),
      },
    }
    const res = await worker.fetch(new Request("https://aquilla.app/another-nonexistent"), env)
    expect(res.status).toBe(404)
    expect(res.headers.get("Content-Type")).toContain("text/plain")
    expect(await res.text()).toBe("Page not found")
  })

  // Real SPA routes should still work with 200
  it("known SPA routes still get the SPA shell with 200", async () => {
    const knownRoutes = [
      "/",
      "/app",
      "/onboarding",
      "/login",
      "/signup",
      "/projects",
      "/shared",
      "/preferences",
      "/orgs/abc123",
      "/project/xyz/editor",
      "/join/token123",
      "/join-org/token456",
      "/check/token789",
      "/link/tokenabc",
      "/approve/changeset123",
      "/__dev/login",
      "/__dev/logout",
      "/__marketing/login",
    ]
    for (const path of knownRoutes) {
      const res = await fetchWorker(path)
      expect(res.status, `${path} should return 200`).toBe(200)
      const body = await res.text()
      expect(body, `${path} should serve content`).toContain(`served:${path}`)
      expect(body, `${path} should have SPA marker`).toContain("This file is the APP shell")
    }
  })

  // AQU-1405: a chunk from a build that has been replaced must not come back as
  // the SPA shell with a 200 — the browser would try to parse HTML as a module
  // (and may cache it under the .js URL). The mock env answers text/html for
  // every path, which is exactly what the SPA fallback does for a missing one.
  it("GET a replaced /assets/ chunk 404s instead of serving the SPA shell", async () => {
    const res = await fetchWorker("/assets/app-chunk-BfoUWN3w.js")
    expect(res.status).toBe(404)
    expect(res.headers.get("Content-Type")).toContain("text/plain")
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(await res.text()).not.toContain("<html")
  })

  it("GET an /assets/ file that exists is served untouched", async () => {
    const { default: worker } = await import("./index")
    const env = {
      ASSETS: {
        fetch: async (): Promise<Response> =>
          new Response("console.log(1)", {
            status: 200,
            headers: { "Content-Type": "application/javascript" },
          }),
      },
    }
    const res = await worker.fetch(new Request("https://aquilla.app/assets/app-chunk-live.js"), env)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("console.log(1)")
  })
})

describe("worker/index — non-canonical host noindex (SEO)", () => {
  async function fetchHost(host: string, path = "/") {
    const { default: worker } = await import("./index")
    return worker.fetch(new Request(`https://${host}${path}`), makeEnv())
  }

  it("dev.aquilla.app responses carry X-Robots-Tag: noindex", async () => {
    const res = await fetchHost("dev.aquilla.app")
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex")
    const body = await res.text()
    expect(body).toContain("served:/")
    expect(body).toContain("This file is the APP shell")
  })

  it("workers.dev preview responses carry X-Robots-Tag: noindex", async () => {
    // /bible-translation is a marketing route, not in our list, so it 404s
    const res = await fetchHost("aquilla-web.example.workers.dev", "/bible-translation")
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex")
    expect(res.status).toBe(404)
  })

  it("production aquilla.app responses have no X-Robots-Tag", async () => {
    // /bible-translation is a marketing route, not in our list, so it 404s
    const res = await fetchHost("aquilla.app", "/bible-translation")
    expect(res.headers.get("X-Robots-Tag")).toBeNull()
    expect(res.status).toBe(404)
  })

  it("localhost dev responses are left untouched", async () => {
    const res = await fetchHost("localhost:8788".split(":")[0])
    expect(res.headers.get("X-Robots-Tag")).toBeNull()
    const body = await res.text()
    expect(body).toContain("served:/")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Deployment-config contract. The marketing Worker owns `/`; making this
// catch-all run first there would add latency and imply ownership it no longer has.
describe("wrangler.toml — SPA-only asset serving", () => {
  const toml = readFileSync(resolve(__dirname, "../wrangler.toml"), "utf8")
  const assetBlocks = toml.split(/^\[.*assets\]$/m).slice(1)

  it("declares an assets block per environment", () => {
    // top-level + preview + production + development. Was 5 until AQU-799
    // retired the staging environment (7c2c3b5) without updating this count —
    // the assertion has been failing ever since, unnoticed because no CI job
    // runs this suite (see docs/OPSEC-REVIEW-2026-08-10.md, OPS-4).
    expect(assetBlocks).toHaveLength(4)
  })

  it("has no run_worker_first — the root is not special here", () => {
    expect(toml).not.toContain("run_worker_first")
  })

  it("keeps SPA fallback on, so app routes still resolve to index.html", () => {
    for (const block of assetBlocks) {
      expect(block).toContain('not_found_handling = "single-page-application"')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// SPA shell marker contract. The soft-404 fix relies on detecting the comment
// "This file is the APP shell" in index.html. If someone rewords that comment,
// the detector would silently start serving soft 404s again.
describe("index.html — SPA shell marker", () => {
  const indexHtml = readFileSync(resolve(__dirname, "../index.html"), "utf8")

  it("contains the marker comment used to detect the SPA shell", () => {
    expect(indexHtml).toContain("This file is the APP shell")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Security headers (docs/OPSEC-REVIEW-2026-08-10.md, OPS-1).
//
// The browser build shipped with no CSP and no framing/transport hardening
// while the Tauri shell had a real CSP. These guard the split rollout: the
// enforced policy stays limited to directives that cannot break a working
// page, and the full policy ships report-only until its violations are clean.
describe("worker/index — security headers", () => {
  it("sets the enforced CSP on every response it serves", async () => {
    for (const path of ["/", "/app", "/project/abc"]) {
      const res = await fetchWorker(path)
      const csp = res.headers.get("Content-Security-Policy") ?? ""
      expect(csp, `${path} must carry a CSP`).toContain("object-src 'none'")
      expect(csp).toContain("base-uri 'self'")
      expect(csp).toContain("frame-ancestors 'self'")
      expect(csp).toContain("form-action 'self'")
    }
  })

  it("keeps script-src/connect-src report-only so a wrong host cannot break prod", async () => {
    const res = await fetchWorker("/app")
    const enforced = res.headers.get("Content-Security-Policy") ?? ""
    const reportOnly = res.headers.get("Content-Security-Policy-Report-Only") ?? ""
    expect(enforced).not.toContain("script-src")
    expect(enforced).not.toContain("connect-src")
    expect(reportOnly).toContain("script-src 'self' 'wasm-unsafe-eval'")
    const scripts = reportOnly.split("; ").find(part =>
      part.startsWith("script-src "),
    )
    expect(scripts?.split(" ")).toContain("https://www.youtube.com")
    expect(reportOnly).toContain("connect-src")
    expect(reportOnly).toContain("default-src 'self'")
  })

  it("sets nosniff, framing, referrer and permissions headers", async () => {
    const res = await fetchWorker("/app")
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(res.headers.get("X-Frame-Options")).toBe("SAMEORIGIN")
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin")
    const pp = res.headers.get("Permissions-Policy") ?? ""
    // Audio recording (getUserMedia) must keep working; nothing else is used.
    expect(pp).toContain("microphone=(self)")
    expect(pp).toContain("camera=()")
    expect(pp).toContain("geolocation=()")
  })

  it("sends HSTS on real hosts and never on localhost", async () => {
    const { default: worker } = await import("./index")
    const prod = await worker.fetch(new Request("https://aquilla.app/app"), makeEnv())
    expect(prod.headers.get("Strict-Transport-Security")).toContain("max-age=31536000")
    const local = await worker.fetch(new Request("http://localhost:5173/app"), makeEnv())
    expect(local.headers.get("Strict-Transport-Security")).toBeNull()
  })

  it("still applies X-Robots-Tag on non-canonical hosts alongside the new headers", async () => {
    const { default: worker } = await import("./index")
    const res = await worker.fetch(new Request("https://dev.aquilla.app/app"), makeEnv())
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex")
    expect(res.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'self'")
  })

  it("does not throw when the asset binding returns a null-body status (304)", async () => {
    const { default: worker } = await import("./index")
    const env = {
      ASSETS: { fetch: async (): Promise<Response> => new Response(null, { status: 304 }) },
    }
    const res = await worker.fetch(new Request("https://aquilla.app/app"), env)
    expect(res.status).toBe(304)
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff")
  })

  it("leaves the routed body and cache policy untouched", async () => {
    const res = await fetchWorker("/")
    const body = await res.text()
    expect(body).toContain("served:/")
    expect(body).toContain("This file is the APP shell")
    expect(res.headers.get("Cache-Control")).toBeNull()
  })
})
