import { describe, it, expect } from "vitest"
import { injectInviteMeta } from "./index"

// A trimmed copy of the built index.html social-meta block, used to assert the
// invite-link rewrite hits the real markup shape.
const SPA_HTML = `<!doctype html><html><head>
  <title>Aquilla</title>
  <meta property="og:title" content="Aquilla" />
  <meta property="og:description" content="Aquilla — translators, lifted." />
  <meta property="og:image" content="https://aquilla.app/aquilla-og.png" />
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
  it("GET / with no cookie serves homepage.html", async () => {
    const res = await fetchWorker("/")
    expect(await res.text()).toBe("served:/homepage.html")
  })

  it("GET / with aq_hint=1 cookie serves index.html", async () => {
    const res = await fetchWorker("/", "aq_hint=1")
    expect(await res.text()).toBe("served:/index.html")
  })

  it("GET / with unrelated cookie still serves homepage.html", async () => {
    const res = await fetchWorker("/", "session=abc123")
    expect(await res.text()).toBe("served:/homepage.html")
  })

  it("GET /homepage always serves homepage.html (no cookie)", async () => {
    const res = await fetchWorker("/homepage")
    expect(await res.text()).toBe("served:/homepage.html")
  })

  it("GET /homepage always serves homepage.html (even with aq_hint=1)", async () => {
    const res = await fetchWorker("/homepage", "aq_hint=1")
    expect(await res.text()).toBe("served:/homepage.html")
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
    // Image is left untouched — only the brand OG image exists.
    expect(html).toContain(`<meta property="og:image" content="https://aquilla.app/aquilla-og.png" />`)
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
