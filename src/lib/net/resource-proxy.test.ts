import { afterEach, describe, expect, it, vi } from "vitest"
import {
  getResourcesBase,
  proxyOrigin,
  proxyResourceUrl,
  proxiedFetch,
} from "./resource-proxy"
import {
  EXTERNAL_CONTENT_HOSTS,
  isProxyableHost,
  proxyResourceRequest,
} from "./resource-proxy-handler"

const BASE = "https://resources.aquilla.app"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("client rewriter — proxy unconfigured (default)", () => {
  it("getResourcesBase is empty when VITE_RESOURCES_BASE is unset", () => {
    expect(getResourcesBase()).toBe("")
  })

  it("proxyOrigin is a transparent no-op", () => {
    expect(proxyOrigin("https://git.door43.org")).toBe("https://git.door43.org")
    expect(proxyOrigin("https://bible.helloao.org")).toBe("https://bible.helloao.org")
  })

  it("proxyResourceUrl is a transparent no-op", () => {
    const u = "https://git.door43.org/api/v1/catalog/search?lang=en"
    expect(proxyResourceUrl(u)).toBe(u)
  })
})

describe("client rewriter — proxy configured", () => {
  it("trims trailing slashes from the base", () => {
    vi.stubEnv("VITE_RESOURCES_BASE", `${BASE}//`)
    expect(getResourcesBase()).toBe(BASE)
  })

  it("rewrites allow-listed origins to <base>/<host>", () => {
    vi.stubEnv("VITE_RESOURCES_BASE", BASE)
    expect(proxyOrigin("https://git.door43.org")).toBe(`${BASE}/git.door43.org`)
    expect(proxyOrigin("https://bible.helloao.org")).toBe(`${BASE}/bible.helloao.org`)
  })

  it("leaves non-allow-listed hosts untouched", () => {
    vi.stubEnv("VITE_RESOURCES_BASE", BASE)
    expect(proxyOrigin("https://evil.example.com")).toBe("https://evil.example.com")
    expect(proxyResourceUrl("https://evil.example.com/x")).toBe("https://evil.example.com/x")
  })

  it("preserves path, query and hash when rewriting a full URL", () => {
    vi.stubEnv("VITE_RESOURCES_BASE", BASE)
    expect(
      proxyResourceUrl("https://git.door43.org/api/v1/catalog/search?lang=en#top"),
    ).toBe(`${BASE}/git.door43.org/api/v1/catalog/search?lang=en#top`)
  })

  it("returns malformed input unchanged rather than throwing", () => {
    vi.stubEnv("VITE_RESOURCES_BASE", BASE)
    expect(proxyOrigin("not a url")).toBe("not a url")
    expect(proxyResourceUrl("not a url")).toBe("not a url")
  })

  it("proxiedFetch fetches the rewritten URL", async () => {
    vi.stubEnv("VITE_RESOURCES_BASE", BASE)
    const fetchImpl = vi.fn().mockResolvedValue(new Response("ok"))
    await proxiedFetch("https://bible.helloao.org/api/x.json", undefined, fetchImpl)
    expect(fetchImpl).toHaveBeenCalledWith(
      `${BASE}/bible.helloao.org/api/x.json`,
      undefined,
    )
  })
})

describe("allow-list", () => {
  it("covers the known content hosts and rejects others", () => {
    expect(EXTERNAL_CONTENT_HOSTS).toContain("git.door43.org")
    expect(isProxyableHost("git.door43.org")).toBe(true)
    expect(isProxyableHost("raw.githubusercontent.com")).toBe(true)
    expect(isProxyableHost("api.aquilla.app")).toBe(false)
  })
})

describe("server handler — proxyResourceRequest", () => {
  it("forwards an allow-listed GET to the right https upstream", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("BODY", { headers: { "content-type": "text/plain" } }))
    const res = await proxyResourceRequest(
      new Request("https://resources.aquilla.app/git.door43.org/api/v1/catalog/search?lang=en"),
      { fetchImpl },
    )
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://git.door43.org/api/v1/catalog/search?lang=en",
      expect.objectContaining({ method: "GET" }),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("BODY")
  })

  it("passes through caching headers and adds CORS", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("x", {
        headers: {
          "content-type": "application/json",
          "cache-control": "max-age=3600",
          etag: '"abc"',
        },
      }),
    )
    const res = await proxyResourceRequest(
      new Request("https://resources.aquilla.app/bible.helloao.org/api/x.json"),
      { fetchImpl },
    )
    expect(res.headers.get("cache-control")).toBe("max-age=3600")
    expect(res.headers.get("etag")).toBe('"abc"')
    expect(res.headers.get("content-type")).toBe("application/json")
    expect(res.headers.get("access-control-allow-origin")).toBe("*")
  })

  it("forwards conditional/range request headers upstream", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 304 }))
    await proxyResourceRequest(
      new Request("https://resources.aquilla.app/git.door43.org/x", {
        headers: { "if-none-match": '"v1"', range: "bytes=0-10" },
      }),
      { fetchImpl },
    )
    const init = fetchImpl.mock.calls[0][1] as RequestInit
    const headers = new Headers(init.headers)
    expect(headers.get("if-none-match")).toBe('"v1"')
    expect(headers.get("range")).toBe("bytes=0-10")
  })

  it("refuses a host that is not allow-listed (no open proxy)", async () => {
    const fetchImpl = vi.fn()
    const res = await proxyResourceRequest(
      new Request("https://resources.aquilla.app/evil.example.com/steal"),
      { fetchImpl },
    )
    expect(res.status).toBe(403)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("refuses non-GET/HEAD methods", async () => {
    const fetchImpl = vi.fn()
    const res = await proxyResourceRequest(
      new Request("https://resources.aquilla.app/git.door43.org/x", { method: "POST" }),
      { fetchImpl },
    )
    expect(res.status).toBe(405)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("maps an upstream network failure to 502", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("boom"))
    const res = await proxyResourceRequest(
      new Request("https://resources.aquilla.app/git.door43.org/x"),
      { fetchImpl },
    )
    expect(res.status).toBe(502)
  })
})
