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
// resolved pathname so tests can assert which file was requested.
function makeEnv() {
  return {
    ASSETS: {
      fetch: async (req: Request | string): Promise<Response> => {
        const url = new URL(typeof req === "string" ? req : req.url)
        return new Response(`served:${url.pathname}`, {
          status: 200,
          headers: { "Content-Type": "text/html" },
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
  // When this Worker sees one on a preview alias, it falls through to the SPA.
  it("GET / passes through to ASSETS (SPA shell)", async () => {
    const res = await fetchWorker("/")
    expect(await res.text()).toBe("served:/")
  })

  it("GET /beta passes through to ASSETS — no marketing routing here", async () => {
    const res = await fetchWorker("/beta")
    expect(await res.text()).toBe("served:/beta")
  })

  it("GET /project/abc passes through to ASSETS unchanged", async () => {
    const res = await fetchWorker("/project/abc")
    expect(await res.text()).toBe("served:/project/abc")
  })

  // /app is the stable entry target linked by the separate marketing site.
  it("GET /app passes through to ASSETS (SPA shell)", async () => {
    const res = await fetchWorker("/app")
    expect(await res.text()).toBe("served:/app")
  })

  it("GET /app is served the SPA shell even when signed in (aq_hint=1)", async () => {
    const res = await fetchWorker("/app", "aq_hint=1")
    expect(await res.text()).toBe("served:/app")
  })

  // AQU-795 / AQU-719 regression guard: a previously Google-indexed interior URL
  // must resolve to the SPA shell (not_found_handling = single-page-application
  // rewrites it to index.html) so React Router opens the page directly — never
  // bounced to marketing and never the old "page not found until you navigate
  // from home" symptom. Marketing routes never reach this Worker on the live
  // custom domains because their more-specific Worker routes win first.
  it("GET interior deep links pass through to ASSETS (SPA shell), not marketing", async () => {
    for (const path of ["/orgs/abc", "/project/abc/editor", "/shared", "/settings"]) {
      const res = await fetchWorker(path)
      expect(await res.text(), `${path} must reach the SPA shell`).toBe(`served:${path}`)
    }
  })

  it("GET /join/xyz passes through to ASSETS (non-HTML body unchanged)", async () => {
    const res = await fetchWorker("/join/xyz")
    expect(await res.text()).toBe("served:/join/xyz")
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

  it("GET /__dev/login passes through to ASSETS unchanged", async () => {
    const res = await fetchWorker("/__dev/login")
    expect(await res.text()).toBe("served:/__dev/login")
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
    expect(await res.text()).toBe("served:/")
  })

  it("workers.dev preview responses carry X-Robots-Tag: noindex", async () => {
    const res = await fetchHost("aquilla-web.example.workers.dev", "/bible-translation")
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex")
  })

  it("production aquilla.app responses have no X-Robots-Tag", async () => {
    const res = await fetchHost("aquilla.app", "/bible-translation")
    expect(res.headers.get("X-Robots-Tag")).toBeNull()
  })

  it("localhost dev responses are left untouched", async () => {
    const res = await fetchHost("localhost:8788".split(":")[0])
    expect(res.headers.get("X-Robots-Tag")).toBeNull()
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
    expect(await res.text()).toBe("served:/")
    expect(res.headers.get("Cache-Control")).toBeNull()
  })
})
