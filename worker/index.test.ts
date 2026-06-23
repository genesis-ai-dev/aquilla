import { describe, it, expect } from "vitest"

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

  it("GET /project/abc passes through to ASSETS unchanged", async () => {
    const res = await fetchWorker("/project/abc")
    expect(await res.text()).toBe("served:/project/abc")
  })

  it("GET /join/xyz passes through to ASSETS unchanged", async () => {
    const res = await fetchWorker("/join/xyz")
    expect(await res.text()).toBe("served:/join/xyz")
  })

  it("GET /__dev/login passes through to ASSETS unchanged", async () => {
    const res = await fetchWorker("/__dev/login")
    expect(await res.text()).toBe("served:/__dev/login")
  })
})
