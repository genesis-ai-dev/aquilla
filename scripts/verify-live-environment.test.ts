import { describe, expect, it, vi } from "vitest"
import { verifyLiveEnvironment } from "./verify-live-environment.mjs"

const lookup = vi.fn(async () => [{ address: "203.0.113.10", family: 4 }])

function response(body: string, status = 200, contentType = "text/plain"): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType },
  })
}

// AQU-798: the spa surface now also verifies the case-study static pages
// resolve to their dedicated documents (distinct hardcoded og:url) rather than
// the SPA index-shell fallback. These helpers let each spa mock serve valid
// case-study documents so the crawl-focused assertions stay in focus.
function caseStudyHtml(ogUrl: string): string {
  return `<!doctype html><html><head><title>Case study — Aquilla</title>`
    + `<meta property="og:url" content="${ogUrl}" /></head><body></body></html>`
}

function serveCaseStudies(origin: string, url: string): Response | null {
  if (url === `${origin}/case-studies/biblica`) {
    return response(caseStudyHtml("https://aquilla.app/case-studies/biblica"), 200, "text/html")
  }
  if (url === `${origin}/case-studies/come-and-see`) {
    return response(caseStudyHtml("https://aquilla.app/case-studies/come-and-see"), 200, "text/html")
  }
  return null
}

function healthyApiFetch(host: string) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url === `https://${host}/identity/api/v2/health`) {
      return response(JSON.stringify({ ok: true, name: "aquilla-identity" }), 200, "application/json")
    }
    if (url === `https://${host}/chat/api/v1/chat/completions`) {
      return response(JSON.stringify({ error: "Authorization header required" }), 401, "application/json")
    }
    if (url === `https://${host}/sync/events`) {
      return response("missing Authorization header", 401)
    }
    throw new Error(`unexpected URL ${url}`)
  })
}

describe("live deployment environment verification", () => {
  it("verifies the production identity, chat, and sync route contracts", async () => {
    const fetchImpl = healthyApiFetch("api.aquilla.app")

    await expect(verifyLiveEnvironment("production", {
      surface: "auth",
      fetchImpl,
      lookup,
      attempts: 1,
      log: vi.fn(),
    })).resolves.toBeUndefined()

    await expect(verifyLiveEnvironment("production", {
      surface: "sync",
      fetchImpl,
      lookup,
      attempts: 1,
      log: vi.fn(),
    })).resolves.toBeUndefined()
  })

  it("rejects a 401 that did not come from the sync Worker guard", async () => {
    const fetchImpl = vi.fn(async () => response("wrong worker", 401))

    await expect(verifyLiveEnvironment("production", {
      surface: "sync",
      fetchImpl,
      lookup,
      attempts: 1,
      log: vi.fn(),
    })).rejects.toThrow("unexpected body")
  })

  it("verifies that production SPA assets contain production targets and no dev targets", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      // The bare origin serves the marketing homepage, whose JS graph lacks
      // the sync/chat targets (AQU-779) — the verifier must crawl /app instead.
      if (url === "https://aquilla.app" || url === "https://aquilla.app/") {
        return response('<script type="module" src="/assets/homepage.js"></script>', 200, "text/html")
      }
      if (url === "https://aquilla.app/assets/homepage.js") {
        return response('"https://api.aquilla.app/identity"')
      }
      if (url === "https://aquilla.app/app") {
        return response('<script type="module" src="/assets/index.js"></script>', 200, "text/html")
      }
      if (url === "https://aquilla.app/assets/index.js") {
        return response('const deps = ["assets/chunk.js"]; import "./chunk.js"')
      }
      if (url === "https://aquilla.app/assets/chunk.js") {
        return response([
          "https://api.aquilla.app/identity",
          "api.aquilla.app/sync",
          "https://api.aquilla.app/chat",
        ].join(" "))
      }
      // This case verifies the PRODUCTION spa surface, so the verifier crawls
      // https://aquilla.app — a leftover staging origin here (the staging
      // profile was retired in AQU-799) meant the mock never matched and the
      // case threw `unexpected URL` instead of asserting anything.
      const caseStudy = serveCaseStudies("https://aquilla.app", url)
      if (caseStudy) return caseStudy
      throw new Error(`unexpected URL ${url}`)
    })

    await expect(verifyLiveEnvironment("production", {
      surface: "spa",
      fetchImpl,
      lookup,
      attempts: 1,
      log: vi.fn(),
    })).resolves.toBeUndefined()

    const requestedUrls = fetchImpl.mock.calls.map(([input]) => String(input))
    expect(requestedUrls).toContain("https://aquilla.app/app")
    expect(requestedUrls).not.toContain("https://aquilla.app")
    expect(requestedUrls).not.toContain("https://aquilla.app/")
  })

  it("rejects a production bundle that also contains a development target", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === "https://aquilla.app/app") {
        return response('<script type="module" src="/assets/index.js"></script>', 200, "text/html")
      }
      return response([
        "https://api.aquilla.app/identity",
        "api.aquilla.app/sync",
        "https://api.aquilla.app/chat",
        "https://api.dev.aquilla.app/identity",
      ].join(" "))
    })

    await expect(verifyLiveEnvironment("production", {
      surface: "spa",
      fetchImpl,
      lookup,
      attempts: 1,
      log: vi.fn(),
    })).rejects.toThrow("cross-environment hosts: api.dev.aquilla.app")
  })

  it("verifies a PR preview origin against development bundle targets", async () => {
    const previewOrigin = "https://pr-274-aquilla-web-preview.blue-darkness-7674.workers.dev"
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === `${previewOrigin}/app`) {
        return response('<script type="module" src="/assets/index.js"></script>', 200, "text/html")
      }
      if (url === `${previewOrigin}/assets/index.js`) {
        return response([
          "https://api.dev.aquilla.app/identity",
          "api.dev.aquilla.app/sync",
          "https://api.dev.aquilla.app/chat",
        ].join(" "))
      }
      const caseStudy = serveCaseStudies(previewOrigin, url)
      if (caseStudy) return caseStudy
      throw new Error(`unexpected URL ${url}`)
    })

    await expect(verifyLiveEnvironment("development", {
      surface: "spa",
      appOrigin: previewOrigin,
      fetchImpl,
      lookup,
      attempts: 1,
      log: vi.fn(),
    })).resolves.toBeUndefined()

    expect(fetchImpl).toHaveBeenCalledWith(`${previewOrigin}/app`, {
      headers: { Accept: "text/html" },
    })
    expect(fetchImpl.mock.calls.flat().map(String)).not.toContain("https://dev.aquilla.app/app")
  })

  it("retries the complete preview crawl while a new alias propagates", async () => {
    const previewOrigin = "https://pr-274-aquilla-web-preview.blue-darkness-7674.workers.dev"
    let entryAttempts = 0
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === `${previewOrigin}/app`) {
        entryAttempts += 1
        if (entryAttempts === 1) return response("not found", 404)
        return response('<script type="module" src="/assets/index.js"></script>', 200, "text/html")
      }
      const caseStudy = serveCaseStudies(previewOrigin, url)
      if (caseStudy) return caseStudy
      return response([
        "https://api.dev.aquilla.app/identity",
        "api.dev.aquilla.app/sync",
        "https://api.dev.aquilla.app/chat",
      ].join(" "))
    })

    await expect(verifyLiveEnvironment("development", {
      surface: "spa",
      appOrigin: previewOrigin,
      fetchImpl,
      lookup,
      attempts: 2,
      retryDelayMs: 0,
      log: vi.fn(),
    })).resolves.toBeUndefined()
    expect(entryAttempts).toBe(2)
  })

  it("verifies production case-study pages resolve to their dedicated documents (AQU-798)", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === "https://aquilla.app/app") {
        return response('<script type="module" src="/assets/index.js"></script>', 200, "text/html")
      }
      if (url === "https://aquilla.app/assets/index.js") {
        return response([
          "https://api.aquilla.app/identity",
          "api.aquilla.app/sync",
          "https://api.aquilla.app/chat",
        ].join(" "))
      }
      const caseStudy = serveCaseStudies("https://aquilla.app", url)
      if (caseStudy) return caseStudy
      throw new Error(`unexpected URL ${url}`)
    })

    await expect(verifyLiveEnvironment("production", {
      surface: "spa",
      fetchImpl,
      lookup,
      attempts: 1,
      log: vi.fn(),
    })).resolves.toBeUndefined()

    const requested = fetchImpl.mock.calls.map(([input]) => String(input))
    expect(requested).toContain("https://aquilla.app/case-studies/biblica")
    expect(requested).toContain("https://aquilla.app/case-studies/come-and-see")
  })

  it("rejects when a case-study path falls back to the SPA index shell (AQU-798)", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === "https://aquilla.app/app") {
        return response('<script type="module" src="/assets/index.js"></script>', 200, "text/html")
      }
      if (url === "https://aquilla.app/assets/index.js") {
        return response([
          "https://api.aquilla.app/identity",
          "api.aquilla.app/sync",
          "https://api.aquilla.app/chat",
        ].join(" "))
      }
      // The case-study HTML is missing from the deployed bundle, so the path
      // falls through single-page-application not-found handling to the SPA
      // index shell — which carries the bare-origin og:url, not the page's own.
      if (url === "https://aquilla.app/case-studies/biblica") {
        return response(caseStudyHtml("https://aquilla.app/"), 200, "text/html")
      }
      const caseStudy = serveCaseStudies("https://aquilla.app", url)
      if (caseStudy) return caseStudy
      throw new Error(`unexpected URL ${url}`)
    })

    await expect(verifyLiveEnvironment("production", {
      surface: "spa",
      fetchImpl,
      lookup,
      attempts: 1,
      log: vi.fn(),
    })).rejects.toThrow("fell back to the SPA index shell")
  })

  it("fails closed for unknown environments and surfaces", async () => {
    await expect(verifyLiveEnvironment("prod", { log: vi.fn() }))
      .rejects.toThrow("unknown environment")
    await expect(verifyLiveEnvironment("production", { surface: "worker" as never, log: vi.fn() }))
      .rejects.toThrow("unknown surface")
    await expect(verifyLiveEnvironment("development", {
      surface: "spa",
      appOrigin: "http://preview.example.com/path",
      log: vi.fn(),
    })).rejects.toThrow("expected an HTTPS origin without a path")
    await expect(verifyLiveEnvironment("development", {
      surface: "auth",
      appOrigin: "https://preview.example.com",
      log: vi.fn(),
    })).rejects.toThrow("may only be used with --surface=spa")
  })
})
