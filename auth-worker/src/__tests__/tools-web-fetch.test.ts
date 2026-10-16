// aquilla.web.fetch proxy (apiRev 6): every rule a hostile extension or site
// could probe — allowlist, https/port/credentials, SSRF (names and resolved
// addresses), redirects re-checked, GET-only with a fixed header set, size and
// content-type caps — against a stub fetch and resolver.

import { describe, expect, it } from "vitest"
import {
  WEB_FETCH_MAX_BINARY_BYTES,
  WEB_FETCH_MAX_BYTES,
  toBase64,
  WebFetchError,
  checkWebUrl,
  deploymentAllowlist,
  isPrivateAddress,
  proxyWebFetch,
  type Resolver,
} from "../lib/tools/web-fetch"

const DOMAINS = ["git.door43.org"]
const publicDns: Resolver = async () => ["104.21.80.1"]

type Seen = { url: string; init: RequestInit }
function site(handler: (url: string) => Response): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init: init ?? {} })
    return handler(String(input))
  }) as typeof fetch
  return { fetch: fetchImpl, seen }
}
const text = (body: string, type = "text/plain; charset=utf-8", status = 200) => new Response(body, { status, headers: { "Content-Type": type } })

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return "ok"
  } catch (err) {
    return err instanceof WebFetchError ? err.code : `unexpected: ${String(err)}`
  }
}

describe("URL checks", () => {
  it("allows https on an approved host, exact or under a *. entry", () => {
    expect(checkWebUrl("https://git.door43.org/unfoldingWord/en_tn/raw/branch/master/tn_MAT.tsv", DOMAINS, null).hostname).toBe("git.door43.org")
    expect(checkWebUrl("https://cdn.door43.org/x", ["*.door43.org"], null).hostname).toBe("cdn.door43.org")
  })

  it.each([
    ["http://git.door43.org/x", "invalid_url"],
    ["https://user:pw@git.door43.org/x", "invalid_url"],
    ["https://git.door43.org:8443/x", "invalid_url"],
    ["https://evil.example.com/x", "host_not_allowed"],
    ["https://door43.org.evil.com/x", "host_not_allowed"],
    ["https://127.0.0.1/x", "host_blocked"],
    ["https://[::1]/x", "host_blocked"],
    ["https://2130706433/x", "host_blocked"],
    ["https://localhost/x", "host_blocked"],
    ["https://metadata.internal/x", "host_blocked"],
    ["not a url", "invalid_url"],
  ])("refuses %s (%s)", (url, expected) => {
    try {
      checkWebUrl(url, DOMAINS, null)
      throw new Error("accepted")
    } catch (err) {
      expect(err instanceof WebFetchError ? err.code : String(err)).toBe(expected)
    }
  })

  it("a *. entry does not cover the bare domain or look-alikes", async () => {
    expect(await code(Promise.resolve().then(() => checkWebUrl("https://door43.org/x", ["*.door43.org"], null)))).toBe("host_not_allowed")
    expect(await code(Promise.resolve().then(() => checkWebUrl("https://xdoor43.org/x", ["*.door43.org"], null)))).toBe("host_not_allowed")
  })

  it("the deployment allowlist narrows what users can approve", async () => {
    expect(deploymentAllowlist("")).toBeNull()
    expect(deploymentAllowlist(" git.door43.org , *.unfoldingword.org ")).toEqual(["git.door43.org", "*.unfoldingword.org"])
    expect(await code(Promise.resolve().then(() => checkWebUrl("https://api.github.com/x", ["api.github.com"], ["git.door43.org"])))).toBe("host_not_allowed")
  })
})

describe("SSRF: resolved addresses", () => {
  it.each(["10.0.0.5", "172.16.3.4", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1", "64:ff9b::7f00:1"])(
    "%s is private",
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  )

  it("public addresses pass", () => {
    expect(isPrivateAddress("104.21.80.1")).toBe(false)
    expect(isPrivateAddress("2606:4700::6810:84e5")).toBe(false)
    expect(isPrivateAddress("64:ff9b::10.0.0.1")).toBe(true)
  })

  it("refuses an approved name that resolves to a private address", async () => {
    const s = site(() => text("secret"))
    expect(await code(proxyWebFetch({ url: "https://git.door43.org/x", as: "text", domains: DOMAINS, deploymentAllow: null }, { fetch: s.fetch, resolve: async () => ["10.1.2.3"] }))).toBe("host_blocked")
    expect(s.seen).toHaveLength(0)
  })
})

describe("the proxied GET", () => {
  it("fetches with GET, no credentials and a fixed header set, and returns status/type/body", async () => {
    const s = site(() => text("Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\n1:1\tabcd\t\t\tΒίβλος\t1\tA note", "text/tab-separated-values"))
    const out = await proxyWebFetch({ url: "https://git.door43.org/unfoldingWord/en_tn/raw/branch/master/tn_MAT.tsv", as: "text", domains: DOMAINS, deploymentAllow: null }, { fetch: s.fetch, resolve: publicDns })
    expect(out).toMatchObject({ status: 200, contentType: "text/tab-separated-values", url: "https://git.door43.org/unfoldingWord/en_tn/raw/branch/master/tn_MAT.tsv" })
    expect(String(out.body)).toContain("1:1\tabcd")
    const init = s.seen[0].init
    expect(init.method).toBe("GET")
    expect(init.redirect).toBe("manual")
    expect(Object.keys(init.headers as Record<string, string>).sort()).toEqual(["Accept", "User-Agent"])
    expect((init as { credentials?: string }).credentials).toBeUndefined()
  })

  it("parses JSON when asked", async () => {
    const s = site(() => text('{"data":[{"name":"en_tn"}]}', "application/json"))
    const out = await proxyWebFetch({ url: "https://git.door43.org/api/v1/catalog/search?owner=unfoldingWord", as: "json", domains: DOMAINS, deploymentAllow: null }, { fetch: s.fetch, resolve: publicDns })
    expect(out.body).toEqual({ data: [{ name: "en_tn" }] })
  })

  it("follows a redirect only to an approved host, re-checking each hop", async () => {
    const ok = site((url) => (url.endsWith("/a") ? new Response(null, { status: 302, headers: { Location: "/b" } }) : text("B")))
    expect((await proxyWebFetch({ url: "https://git.door43.org/a", as: "text", domains: DOMAINS, deploymentAllow: null }, { fetch: ok.fetch, resolve: publicDns })).body).toBe("B")
    const bad = site(() => new Response(null, { status: 302, headers: { Location: "https://169.254.169.254/latest/meta-data" } }))
    expect(await code(proxyWebFetch({ url: "https://git.door43.org/a", as: "text", domains: DOMAINS, deploymentAllow: null }, { fetch: bad.fetch, resolve: publicDns }))).toBe("host_blocked")
    const off = site(() => new Response(null, { status: 301, headers: { Location: "https://elsewhere.org/x" } }))
    expect(await code(proxyWebFetch({ url: "https://git.door43.org/a", as: "text", domains: DOMAINS, deploymentAllow: null }, { fetch: off.fetch, resolve: publicDns }))).toBe("host_not_allowed")
    const loop = site(() => new Response(null, { status: 302, headers: { Location: "/again" } }))
    expect(await code(proxyWebFetch({ url: "https://git.door43.org/a", as: "text", domains: DOMAINS, deploymentAllow: null }, { fetch: loop.fetch, resolve: publicDns }))).toBe("too_many_redirects")
  })

  it("refuses binary content and oversized bodies (declared or streamed)", async () => {
    const img = site(() => text("PNG", "image/png"))
    expect(await code(proxyWebFetch({ url: "https://git.door43.org/x.png", as: "text", domains: DOMAINS, deploymentAllow: null }, { fetch: img.fetch, resolve: publicDns }))).toBe("unsupported_type")
    const declared = site(() => new Response("x", { headers: { "Content-Type": "text/plain", "Content-Length": String(WEB_FETCH_MAX_BYTES + 1) } }))
    expect(await code(proxyWebFetch({ url: "https://git.door43.org/x", as: "text", domains: DOMAINS, deploymentAllow: null }, { fetch: declared.fetch, resolve: publicDns }))).toBe("too_large")
    const streamed = site(() => text("a".repeat(WEB_FETCH_MAX_BYTES + 10)))
    expect(await code(proxyWebFetch({ url: "https://git.door43.org/x", as: "text", domains: DOMAINS, deploymentAllow: null }, { fetch: streamed.fetch, resolve: publicDns }))).toBe("too_large")
  })

  it("passes the site's error status through instead of failing", async () => {
    const s = site(() => text("Not found", "text/plain", 404))
    const out = await proxyWebFetch({ url: "https://git.door43.org/missing", as: "json", domains: DOMAINS, deploymentAllow: null }, { fetch: s.fetch, resolve: publicDns })
    expect(out.status).toBe(404)
    expect(out.body).toBe("Not found")
  })

  it("reports a timeout as its own code", async () => {
    const slow = (async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" })
    }) as unknown as typeof fetch
    expect(await code(proxyWebFetch({ url: "https://git.door43.org/x", as: "text", domains: DOMAINS, deploymentAllow: null }, { fetch: slow, resolve: publicDns }))).toBe("timeout")
  })
})

describe("bytes (apiRev 7)", () => {
  it("returns a binary body as base64 regardless of content type, and keeps the text-only rule for text", async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 255])
    const s = site(() => new Response(zip, { headers: { "Content-Type": "application/zip" } }))
    const out = await proxyWebFetch({ url: "https://git.door43.org/a.zip", as: "bytes", domains: DOMAINS, deploymentAllow: null }, { fetch: s.fetch, resolve: publicDns })
    expect(out.body).toBe(toBase64(zip))
    expect(atob(out.body as string).length).toBe(zip.length)
    const asText = site(() => new Response(zip, { headers: { "Content-Type": "application/zip" } }))
    expect(await code(proxyWebFetch({ url: "https://git.door43.org/a.zip", as: "text", domains: DOMAINS, deploymentAllow: null }, { fetch: asText.fetch, resolve: publicDns }))).toBe("unsupported_type")
  })

  it("caps binary bodies at the binary limit", async () => {
    const big = site(() => new Response("x", { headers: { "Content-Type": "application/zip", "Content-Length": String(WEB_FETCH_MAX_BINARY_BYTES + 1) } }))
    expect(await code(proxyWebFetch({ url: "https://git.door43.org/a.zip", as: "bytes", domains: DOMAINS, deploymentAllow: null }, { fetch: big.fetch, resolve: publicDns }))).toBe("too_large")
  })

  it("encodes large arrays without blowing the stack", () => {
    const bytes = new Uint8Array(300_000).map((_, i) => i % 256)
    expect(atob(toBase64(bytes)).length).toBe(bytes.length)
  })
})
