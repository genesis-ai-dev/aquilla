// Unit tests for the shared Aquifer client (lib/aquifer/client.ts).
//
// WHY: this is the only code that talks to bibletranslation.org. These freeze
// the hardening guarantees the rest of the feature relies on: host allowlist
// (no SSRF), speculative format=md, defensive truncation, citation requirement,
// and never-throws error surfacing. fetch is mocked — no network, no PG.

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  aquiferSearch,
  aquiferReadPage,
  aquiferPublishAnswer,
  normalizeAquiferPath,
} from "../lib/aquifer/client"
import type { Env } from "../types"

const ENV = { AQUIFER_BASE_URL: "https://bibletranslation.org" } as Env

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

afterEach(() => vi.restoreAllMocks())

describe("normalizeAquiferPath", () => {
  it("accepts site-relative paths", () => {
    expect(normalizeAquiferPath("/en/people/abraham/")).toBe("/en/people/abraham/")
    expect(normalizeAquiferPath("en/passages/RUT/1/8/")).toBe("/en/passages/RUT/1/8/")
  })
  it("rejects absolute URLs, protocol-relative, and traversal", () => {
    expect(normalizeAquiferPath("https://evil.example/x")).toBeNull()
    expect(normalizeAquiferPath("//evil.example/x")).toBeNull()
    expect(normalizeAquiferPath("/en/../../etc/passwd")).toBeNull()
    expect(normalizeAquiferPath("")).toBeNull()
  })
})

describe("aquiferSearch", () => {
  it("composes the URL against the allowlisted base and returns parsed results", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ query: "abraham", lang: "en", count: 1, results: [{ title: "Abraham", url: "x", kind: "person", description: "d" }] }),
    )
    const res = await aquiferSearch(ENV, "abraham", { limit: 3 })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.results[0].title).toBe("Abraham")
    const calledUrl = String(spy.mock.calls[0][0])
    expect(calledUrl).toBe("https://bibletranslation.org/api/search?q=abraham&lang=en&limit=3")
    // A descriptive UA is sent (the live site 403s generic ones).
    const init = spy.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>)["User-Agent"]).toContain("Aquilla")
  })

  it("rejects an empty query without hitting the network", async () => {
    const spy = vi.spyOn(globalThis, "fetch")
    const res = await aquiferSearch(ENV, "   ")
    expect(res.ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it("clamps limit into [1,20]", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ count: 0, results: [] }))
    await aquiferSearch(ENV, "x", { limit: 999 })
    expect(String(spy.mock.calls[0][0])).toContain("limit=20")
  })

  it("surfaces a non-2xx as a typed error, not a throw", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("forbidden", { status: 403 }))
    const res = await aquiferSearch(ENV, "x")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("403")
  })
})

describe("aquiferReadPage", () => {
  it("sends format=md speculatively and validates the path", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ path: "/en/people/abraham/", url: "u", title: "Abraham", truncated: false, text: "Abraham..." }),
    )
    const res = await aquiferReadPage(ENV, "/en/people/abraham/")
    expect(res.ok).toBe(true)
    const url = String(spy.mock.calls[0][0])
    expect(url).toContain("/api/page?path=%2Fen%2Fpeople%2Fabraham%2F")
    expect(url).toContain("format=md")
  })

  it("rejects an out-of-allowlist path without fetching", async () => {
    const spy = vi.spyOn(globalThis, "fetch")
    const res = await aquiferReadPage(ENV, "https://evil.example/x")
    expect(res.ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it("returns a typed error on non-JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>not json</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    )
    const res = await aquiferReadPage(ENV, "/en/people/abraham/")
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain("non-JSON")
  })
})

describe("aquiferPublishAnswer", () => {
  it("requires question, answer, and >=1 citation before POSTing", async () => {
    const spy = vi.spyOn(globalThis, "fetch")
    const res = await aquiferPublishAnswer(ENV, {
      question: "q",
      answer: "a",
      status: "answered",
      citations: [],
    })
    expect(res.ok).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it("POSTs a valid payload and returns the wiki url", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ url: "https://bibletranslation.org/qa/what-is-chesed/" }),
    )
    const res = await aquiferPublishAnswer(ENV, {
      question: "What is chesed?",
      answer: "Covenant faithfulness.",
      status: "answered",
      citations: [{ url: "https://bibletranslation.org/en/terms/chesed/" }],
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.url).toContain("/qa/")
    const init = spy.mock.calls[0][1] as RequestInit
    expect(init.method).toBe("POST")
  })
})
