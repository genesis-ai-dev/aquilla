// AQU-1937: the aquilla.web.fetch response cache and the timeout ladder.
// A repeat read answers from the cache without touching the site; freshness
// follows Cache-Control; stale copies with an ETag are revalidated (304 renews
// them); no-store and non-200s are never kept; copies are per tool. And every
// layer gives up after the one below it, with a clear slow/large error.

import { describe, expect, it } from "vitest"
import {
  WEB_CACHE_DEFAULT_TTL_S,
  cachedWebFetch,
  freshCached,
  freshnessSeconds,
  webCacheKey,
  type CachedWebEntry,
  type WebCacheStore,
} from "../lib/tools/web-fetch-cache"
import { WebFetchError, proxyWebFetch, type Resolver } from "../lib/tools/web-fetch"
import {
  BRIDGE_CALL_TIMEOUT_MS,
  BRIDGE_WEB_FETCH_TIMEOUT_MS,
  CHOICES_TIME_LIMIT_MS,
  WEB_FETCH_DNS_TIMEOUT_MS,
  WEB_FETCH_IMPORTER_TIMEOUT_MS,
  WEB_FETCH_TIMEOUT_MS,
} from "../../../shared/tools/timeouts"

const DOMAINS = ["git.door43.org"]
const URL_ = "https://git.door43.org/api/v1/catalog/search?lang=en"
const publicDns: Resolver = async () => ["104.21.80.1"]

function memoryStore(): WebCacheStore & { map: Map<string, CachedWebEntry> } {
  const map = new Map<string, CachedWebEntry>()
  return { map, get: async (k) => map.get(k) ?? null, put: async (k, e) => void map.set(k, e) }
}

function site(respond: (init: RequestInit) => Response) {
  const calls: RequestInit[] = []
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init ?? {})
    return respond(init ?? {})
  }) as typeof fetch
  return { fetchImpl, calls }
}

const json = (body: string, headers: Record<string, string> = {}, status = 200) =>
  new Response(status === 304 ? null : body, { status, headers: { "Content-Type": "application/json", ...headers } })

function run(store: WebCacheStore | null, fetchImpl: typeof fetch, now: () => number, toolId = "tool-1") {
  return cachedWebFetch({ toolId, url: URL_, as: "text", domains: DOMAINS, deploymentAllow: null }, { fetch: fetchImpl, resolve: publicDns, store, now })
}

describe("web.fetch response cache", () => {
  it("answers a repeat read from the cache without touching the site", async () => {
    const store = memoryStore()
    const s = site(() => json('{"data":[1]}'))
    const first = await run(store, s.fetchImpl, () => 0)
    const second = await run(store, s.fetchImpl, () => 60_000)
    expect([first.cache, second.cache]).toEqual(["miss", "hit"])
    expect(second.body).toBe('{"data":[1]}')
    expect(s.calls).toHaveLength(1)
    expect(await freshCached(store, webCacheKey("tool-1", "text", URL_), () => 60_000)).not.toBeNull()
  })

  it("keeps copies per tool: another extension does not read this one's cache", async () => {
    const store = memoryStore()
    const s = site(() => json("{}"))
    await run(store, s.fetchImpl, () => 0, "tool-1")
    const other = await run(store, s.fetchImpl, () => 1, "tool-2")
    expect(other.cache).toBe("miss")
    expect(s.calls).toHaveLength(2)
  })

  it("revalidates a stale copy with its ETag; a 304 renews it without a download", async () => {
    const store = memoryStore()
    let n = 0
    const s = site(() => (n++ === 0 ? json('{"v":1}', { ETag: '"abc"', "Cache-Control": "max-age=120" }) : json("", { ETag: '"abc"' }, 304)))
    await run(store, s.fetchImpl, () => 0)
    const again = await run(store, s.fetchImpl, () => 121_000)
    expect(again.cache).toBe("revalidated")
    expect(again.status).toBe(200)
    expect(again.body).toBe('{"v":1}')
    expect((s.calls[1].headers as Record<string, string>)["If-None-Match"]).toBe('"abc"')
  })

  it("follows Cache-Control: no-store is never kept; max-age is capped; default is short; a one-minute floor", async () => {
    expect(freshnessSeconds("no-store")).toBeNull()
    // Door43's Gitea answers every API call with this (no validator): reopening must still be instant.
    expect(freshnessSeconds("max-age=0, private, must-revalidate")).toBe(60)
    expect(freshnessSeconds("no-cache")).toBe(60)
    expect(freshnessSeconds("public, max-age=600")).toBe(600)
    expect(freshnessSeconds("max-age=999999")).toBe(3600)
    expect(freshnessSeconds(null)).toBe(WEB_CACHE_DEFAULT_TTL_S)
    const store = memoryStore()
    const s = site(() => json("{}", { "Cache-Control": "no-store" }))
    await run(store, s.fetchImpl, () => 0)
    expect(store.map.size).toBe(0)
  })

  it("never stores an error answer", async () => {
    const store = memoryStore()
    const s = site(() => json("down", {}, 503))
    await run(store, s.fetchImpl, () => 0)
    expect(store.map.size).toBe(0)
  })

  it("works without a store (bypass)", async () => {
    const s = site(() => json("{}"))
    expect((await run(null, s.fetchImpl, () => 0)).cache).toBe("bypass")
  })
})

describe("timeout ladder", () => {
  it("each layer gives up after the one below it", () => {
    const slowestProxy = WEB_FETCH_DNS_TIMEOUT_MS + Math.max(WEB_FETCH_TIMEOUT_MS, WEB_FETCH_IMPORTER_TIMEOUT_MS)
    expect(BRIDGE_WEB_FETCH_TIMEOUT_MS).toBeGreaterThan(slowestProxy)
    expect(CHOICES_TIME_LIMIT_MS).toBeGreaterThan(BRIDGE_WEB_FETCH_TIMEOUT_MS)
    // UI calls stay short.
    expect(BRIDGE_CALL_TIMEOUT_MS).toBeLessThan(BRIDGE_WEB_FETCH_TIMEOUT_MS)
    expect(WEB_FETCH_TIMEOUT_MS).toBeLessThan(WEB_FETCH_IMPORTER_TIMEOUT_MS)
  })

  it("a slow site fails with how long it waited, how much arrived, and what to ask for instead", async () => {
    const encoder = new TextEncoder()
    const slowBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("x".repeat(2 * 1024 * 1024)))
        // …and then nothing more.
      },
    })
    const fetchImpl = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      const res = new Response(slowBody, { status: 200, headers: { "Content-Type": "application/json" } })
      init?.signal?.addEventListener("abort", () => slowBody.cancel().catch(() => {}))
      return res
    }) as typeof fetch
    const err = await proxyWebFetch({ url: URL_, as: "text", domains: DOMAINS, deploymentAllow: null, timeoutMs: 50 }, { fetch: fetchImpl, resolve: publicDns }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WebFetchError)
    expect((err as WebFetchError).code).toBe("timeout")
    expect((err as WebFetchError).message).toMatch(/longer than 0 s|longer than \d+ s/)
    expect((err as WebFetchError).message).toMatch(/2\.0 MB received/)
    expect((err as WebFetchError).message).toMatch(/narrower listing/)
  })

  it("an oversized answer says so and suggests a narrower request", async () => {
    const fetchImpl = (async () => new Response("x", { status: 200, headers: { "Content-Type": "application/json", "Content-Length": String(50 * 1024 * 1024) } })) as unknown as typeof fetch
    const err = await proxyWebFetch({ url: URL_, as: "text", domains: DOMAINS, deploymentAllow: null }, { fetch: fetchImpl, resolve: publicDns }).catch((e: unknown) => e)
    expect((err as WebFetchError).code).toBe("too_large")
    expect((err as WebFetchError).message).toMatch(/narrower listing/)
  })
})
