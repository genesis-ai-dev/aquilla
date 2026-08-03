import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it, expect } from "vitest"
import { injectInviteMeta } from "./index"

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
  // `/` is the marketing homepage for everyone. It used to branch on the
  // aq_hint cookie; that never actually ran in production (the asset router
  // preempted the Worker) and it made the most-requested URL on the site
  // uncacheable. Identity is resolved in the browser now — AppEntryBanner.
  it("GET / serves homepage.html with no cookie", async () => {
    const res = await fetchWorker("/")
    expect(await res.text()).toBe("served:/homepage.html")
  })

  it("GET / serves homepage.html even with aq_hint=1 — no identity branch", async () => {
    const res = await fetchWorker("/", "aq_hint=1")
    expect(await res.text()).toBe("served:/homepage.html")
  })

  it("GET / is byte-identical regardless of cookies, so it can be shared-cached", async () => {
    const anon = await (await fetchWorker("/")).text()
    const signedIn = await (await fetchWorker("/", "aq_hint=1")).text()
    const other = await (await fetchWorker("/", "someone=else")).text()
    expect(signedIn).toBe(anon)
    expect(other).toBe(anon)
  })

  it("GET / is edge-cacheable and does not vary on Cookie", async () => {
    const res = await fetchWorker("/", "aq_hint=1")
    const cc = res.headers.get("Cache-Control") ?? ""
    expect(cc).toContain("public")
    expect(cc).toMatch(/s-maxage=\d+/)
    expect(cc).not.toContain("no-store")
    expect(res.headers.get("Vary") ?? "").not.toMatch(/cookie/i)
  })

  it("GET /homepage always serves homepage.html (no cookie)", async () => {
    const res = await fetchWorker("/homepage")
    expect(await res.text()).toBe("served:/homepage.html")
  })

  it("GET /homepage always serves homepage.html (even with aq_hint=1)", async () => {
    const res = await fetchWorker("/homepage", "aq_hint=1")
    expect(await res.text()).toBe("served:/homepage.html")
  })

  it("GET /bible-translation always serves bible-translation.html (no cookie)", async () => {
    const res = await fetchWorker("/bible-translation")
    expect(await res.text()).toBe("served:/bible-translation.html")
  })

  it("GET /bible-translation always serves bible-translation.html (even with aq_hint=1)", async () => {
    const res = await fetchWorker("/bible-translation", "aq_hint=1")
    expect(await res.text()).toBe("served:/bible-translation.html")
  })

  it("GET /beta serves beta.html (static marketing page, no cookie)", async () => {
    const res = await fetchWorker("/beta")
    expect(await res.text()).toBe("served:/beta.html")
  })

  it("GET /beta serves beta.html even when signed in (aq_hint=1)", async () => {
    const res = await fetchWorker("/beta", "aq_hint=1")
    expect(await res.text()).toBe("served:/beta.html")
  })

  it("GET /betamax is NOT treated as the /beta page (passes through to ASSETS)", async () => {
    const res = await fetchWorker("/betamax")
    expect(await res.text()).toBe("served:/betamax")
  })

  it("GET /case-studies/come-and-see serves case-study.html (static marketing page)", async () => {
    const res = await fetchWorker("/case-studies/come-and-see")
    expect(await res.text()).toBe("served:/case-study.html")
  })

  it("GET /case-studies/come-and-see serves case-study.html even when signed in", async () => {
    const res = await fetchWorker("/case-studies/come-and-see", "aq_hint=1")
    expect(await res.text()).toBe("served:/case-study.html")
  })

  it("GET /case-studies/biblica serves case-study-biblica.html (static marketing page)", async () => {
    const res = await fetchWorker("/case-studies/biblica")
    expect(await res.text()).toBe("served:/case-study-biblica.html")
  })

  it("GET /case-studies/biblica serves case-study-biblica.html even when signed in", async () => {
    const res = await fetchWorker("/case-studies/biblica", "aq_hint=1")
    expect(await res.text()).toBe("served:/case-study-biblica.html")
  })

  it("GET /project/abc passes through to ASSETS unchanged", async () => {
    const res = await fetchWorker("/project/abc")
    expect(await res.text()).toBe("served:/project/abc")
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
})

describe("worker/index — non-canonical host noindex (SEO)", () => {
  async function fetchHost(host: string, path = "/") {
    const { default: worker } = await import("./index")
    return worker.fetch(new Request(`https://${host}${path}`), makeEnv())
  }

  it("dev.aquilla.app responses carry X-Robots-Tag: noindex", async () => {
    const res = await fetchHost("dev.aquilla.app")
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex")
    expect(await res.text()).toBe("served:/homepage.html")
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
// Deployment-config contract.
//
// The routing tests above call the Worker's `fetch` directly. In production the
// Cloudflare asset router runs BEFORE the Worker and serves any path it can
// resolve to an asset — and `/` resolves to index.html. So "GET / with no
// cookie serves homepage.html" passed here for months while aquilla.app/`
// served the empty SPA shell to every signed-out visitor and crawler.
//
// `run_worker_first` is what makes the tests above describe reality. It is
// deployment config, not code, so it needs its own assertion — this is the
// level the regression escaped at.
describe("wrangler.toml — asset router must not preempt the Worker at /", () => {
  const toml = readFileSync(resolve(__dirname, "../wrangler.toml"), "utf8")
  const assetBlocks = toml.split(/^\[.*assets\]$/m).slice(1)

  it("declares an assets block per environment", () => {
    // top-level + production + development + staging + preview
    expect(assetBlocks).toHaveLength(5)
  })

  it("runs the Worker first for / in every environment", () => {
    for (const block of assetBlocks) {
      const decl = /run_worker_first\s*=\s*\[([^\]]*)\]/.exec(block)
      expect(decl, `an assets block is missing run_worker_first:\n${block.trim().slice(0, 200)}`).toBeTruthy()
      expect(decl![1]).toContain('"/"')
    }
  })

  it("keeps SPA fallback on, so app routes still resolve to index.html", () => {
    for (const block of assetBlocks) {
      expect(block).toContain('not_found_handling = "single-page-application"')
    }
  })
})
