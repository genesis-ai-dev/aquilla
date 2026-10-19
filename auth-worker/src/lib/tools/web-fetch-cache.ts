// AQU-1937: a response cache for aquilla.web.fetch, so ANY extension's repeat
// reads (reopening a dialog, a catalog asked for twice) answer instantly and
// spare the upstream.
//
//   - Key: tool + body form + URL. The proxy never forwards cookies or auth, so
//     an answer is the same for every user of that tool; scoping by tool keeps
//     one extension from reading what another fetched.
//   - Only 200s of text/JSON, at most WEB_FETCH_MAX_BYTES, are stored.
//   - Freshness follows the site: Cache-Control no-store → never stored;
//     max-age / s-maxage → that long (capped at an hour); nothing said → a
//     short default (5 minutes). A one-minute FLOOR applies otherwise: API
//     servers such as Door43's Gitea mark every answer "max-age=0, private,
//     must-revalidate" with no validator, even for a catalog that changes
//     daily, and honouring that literally would refetch ~1 MB on every
//     reopen. "private" is about shared caches; this one is per extension.
//   - Stale copies with an ETag / Last-Modified are REVALIDATED (a 304 renews
//     them without re-downloading); stale copies without either are refetched.
//
// The store is injected (Workers Cache API in production, a Map in tests).

import { type WebFetchDeps, type WebFetchResult, proxyWebFetch } from "./web-fetch"

export const WEB_CACHE_DEFAULT_TTL_S = 300
export const WEB_CACHE_MIN_TTL_S = 60
export const WEB_CACHE_MAX_TTL_S = 3600
/** How long a stale copy is kept around for revalidation. */
export const WEB_CACHE_KEEP_S = 24 * 3600

export interface CachedWebEntry {
  result: WebFetchResult
  storedAt: number
  /** Milliseconds the copy may be served without asking the site. */
  freshForMs: number
}

export interface WebCacheStore {
  get(key: string): Promise<CachedWebEntry | null>
  put(key: string, entry: CachedWebEntry, keepSeconds: number): Promise<void>
}

export type CacheOutcome = "hit" | "revalidated" | "miss" | "bypass"

/** Seconds the site lets us reuse an answer; null = do not store at all. */
export function freshnessSeconds(cacheControl: string | null | undefined): number | null {
  const cc = (cacheControl ?? "").toLowerCase()
  if (/(^|[\s,])no-store\b/.test(cc)) return null
  if (/(^|[\s,])no-cache\b/.test(cc)) return WEB_CACHE_MIN_TTL_S
  const m = /(?:^|[\s,])s-maxage=(\d+)/.exec(cc) ?? /(?:^|[\s,])max-age=(\d+)/.exec(cc)
  if (m) return Math.max(WEB_CACHE_MIN_TTL_S, Math.min(Number(m[1]), WEB_CACHE_MAX_TTL_S))
  return WEB_CACHE_DEFAULT_TTL_S
}

export function webCacheKey(toolId: string, as: string, url: string): string {
  return `${toolId}|${as}|${url}`
}

function storable(r: WebFetchResult, as: string): boolean {
  return r.status === 200 && as !== "bytes"
}

/** A copy still fresh enough to serve without touching the site (or the rate limit). */
export async function freshCached(store: WebCacheStore | null, key: string, now: () => number = Date.now): Promise<WebFetchResult | null> {
  if (!store) return null
  const cached = await store.get(key).catch(() => null)
  return cached && now() - cached.storedAt < cached.freshForMs ? cached.result : null
}

/** proxyWebFetch behind the cache. */
export async function cachedWebFetch(
  input: Parameters<typeof proxyWebFetch>[0] & { toolId: string },
  deps: WebFetchDeps & { store: WebCacheStore | null; now?: () => number },
): Promise<WebFetchResult & { cache: CacheOutcome }> {
  const now = deps.now ?? Date.now
  const store = deps.store
  if (!store || input.as === "bytes") return { ...(await proxyWebFetch(input, deps)), cache: "bypass" }

  const key = webCacheKey(input.toolId, input.as, input.url.trim())
  const cached = await store.get(key).catch(() => null)
  if (cached && now() - cached.storedAt < cached.freshForMs) return { ...cached.result, cache: "hit" }

  const conditional = cached ? { etag: cached.result.etag ?? null, lastModified: cached.result.lastModified ?? null } : undefined
  const fresh = await proxyWebFetch({ ...input, ...(conditional && (conditional.etag || conditional.lastModified) ? { conditional } : {}) }, deps)

  if (fresh.status === 304 && cached) {
    const ttl = freshnessSeconds(fresh.cacheControl ?? cached.result.cacheControl) ?? 0
    const renewed: CachedWebEntry = {
      result: { ...cached.result, etag: fresh.etag ?? cached.result.etag ?? null, lastModified: fresh.lastModified ?? cached.result.lastModified ?? null },
      storedAt: now(),
      freshForMs: ttl * 1000,
    }
    await store.put(key, renewed, WEB_CACHE_KEEP_S).catch(() => {})
    return { ...renewed.result, cache: "revalidated" }
  }

  if (storable(fresh, input.as)) {
    const ttl = freshnessSeconds(fresh.cacheControl)
    if (ttl !== null) {
      await store.put(key, { result: fresh, storedAt: now(), freshForMs: ttl * 1000 }, WEB_CACHE_KEEP_S).catch(() => {})
    }
  }
  return { ...fresh, cache: "miss" }
}

/** The Workers Cache API as a WebCacheStore (per data center; best effort). */
export function workersCacheStore(cache: Cache): WebCacheStore {
  const req = (key: string) => new Request(`https://web-fetch-cache.aquilla.internal/${encodeURIComponent(key)}`)
  return {
    async get(key) {
      const res = await cache.match(req(key))
      if (!res) return null
      return (await res.json()) as CachedWebEntry
    },
    async put(key, entry, keepSeconds) {
      await cache.put(
        req(key),
        new Response(JSON.stringify(entry), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${keepSeconds}` } }),
      )
    },
  }
}
