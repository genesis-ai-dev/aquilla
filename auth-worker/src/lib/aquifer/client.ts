// Shared client for the Bible Aquifer reference API (bibletranslation.org).
//
// One typed, hardened wrapper used by BOTH the agent (execute.aquifer branch,
// routes/agent.ts) and the read-only HTTP routes the Search dock calls
// (routes/aquifer.ts). Server-side only — no CORS, the OpenRouter/identity
// secrets never leave the worker.
//
// Hardening:
//   * Host allowlist — callers pass a *path* or a *query*, never a full URL.
//     The final URL is composed against env.AQUIFER_BASE_URL, so the model and
//     the UI cannot point us at an arbitrary origin (no SSRF).
//   * Descriptive User-Agent — the live site 403s generic UAs (verified).
//   * AbortController timeout, defensive response size cap.
//   * Workers Cache API on the two idempotent GETs (best-effort, feature-gated).
//   * Every method returns a Result — it never throws into the agent loop or an
//     HTTP handler.
//
// `format=md` is sent speculatively on page reads: the site ignores it today
// (returns plain text) and will return markdown the day it's supported, with no
// client change required.
//
// Design: docs/superpowers/specs/2026-06-13-aquifer-integration-design.md.

import type { Env } from "../../types"

const DEFAULT_BASE_URL = "https://bibletranslation.org"
const DEFAULT_USER_AGENT = "Aquilla/1.0 (+https://aquilla.app)"
const TIMEOUT_MS = 5_000
/** Defensive ceiling even when a caller omits max_chars (≈ 200 KB). */
const MAX_RESPONSE_BYTES = 200_000
const DEFAULT_SEARCH_LIMIT = 5
const MAX_SEARCH_LIMIT = 20
const DEFAULT_PAGE_MAX_CHARS = 15_000

export type AquiferResult<T> = { ok: true; data: T } | { ok: false; error: string }

export type AquiferKind =
  | "book"
  | "person"
  | "place"
  | "term"
  | "group"
  | "fauna"
  | "flora"
  | "deity"
  | "realia"
  | "theme"
  | "manual"
  | "translator-question"
  | "story"

export interface AquiferSearchHit {
  title: string
  url: string
  kind: AquiferKind | string
  description: string
}

export interface AquiferSearchResponse {
  query: string
  lang: string
  count: number
  results: AquiferSearchHit[]
}

export interface AquiferPage {
  path: string
  url: string
  title: string
  truncated: boolean
  text: string
}

export interface AquiferCitation {
  url: string
  title?: string
  quote?: string
}

export interface AquiferPublishPayload {
  question: string
  answer: string
  status: "answered" | "undetermined"
  citations: AquiferCitation[]
  lang?: string
  agent?: { name?: string; model?: string }
}

export interface AquiferPublishResponse {
  url: string
  [k: string]: unknown
}

function baseUrl(env: Env): string {
  return (env.AQUIFER_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "")
}

function userAgent(env: Env): string {
  return env.AQUIFER_USER_AGENT || DEFAULT_USER_AGENT
}

/**
 * Validate a model/UI-supplied page path. Must be a site-relative path like
 * `/en/people/abraham/` or `/en/passages/RUT/1/8/` — no scheme, no host, no
 * traversal. Returns the normalized path or null if rejected.
 */
export function normalizeAquiferPath(raw: string): string | null {
  if (typeof raw !== "string") return null
  let path = raw.trim()
  if (!path) return null
  // Reject absolute URLs / protocol-relative / traversal outright.
  if (path.includes("://") || path.startsWith("//") || path.includes("..")) return null
  if (!path.startsWith("/")) path = `/${path}`
  // Conservative charset for the known page paths (letters, digits, /_-:.).
  if (!/^\/[A-Za-z0-9/_.:-]*$/.test(path)) return null
  return path
}

async function fetchText(
  url: string,
  init: RequestInit,
  env: Env,
): Promise<AquiferResult<{ text: string; contentType: string }>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": userAgent(env),
        Accept: "application/json, text/plain;q=0.9, */*;q=0.5",
        ...(init.headers ?? {}),
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      return { ok: false, error: `aquifer ${res.status}: ${body.slice(0, 200)}` }
    }
    const contentType = res.headers.get("content-type") ?? ""
    const text = await res.text()
    if (text.length > MAX_RESPONSE_BYTES) {
      return { ok: true, data: { text: text.slice(0, MAX_RESPONSE_BYTES), contentType } }
    }
    return { ok: true, data: { text, contentType } }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: controller.signal.aborted ? "aquifer request timed out" : msg }
  } finally {
    clearTimeout(timer)
  }
}

/** Best-effort Workers Cache API wrapper for idempotent GETs. */
async function cachedGet(url: string, env: Env): Promise<AquiferResult<{ text: string; contentType: string }>> {
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default
  const cacheKey = new Request(url, { method: "GET" })
  if (cache) {
    try {
      const hit = await cache.match(cacheKey)
      if (hit) {
        const text = await hit.text()
        return { ok: true, data: { text, contentType: hit.headers.get("content-type") ?? "" } }
      }
    } catch {
      /* cache miss / unavailable — fall through to network */
    }
  }
  const res = await fetchText(url, { method: "GET" }, env)
  if (res.ok && cache) {
    try {
      await cache.put(
        cacheKey,
        new Response(res.data.text, {
          headers: { "content-type": res.data.contentType || "text/plain", "cache-control": "max-age=900" },
        }),
      )
    } catch {
      /* cache write best-effort */
    }
  }
  return res
}

function parseJson<T>(text: string): AquiferResult<T> {
  try {
    return { ok: true, data: JSON.parse(text) as T }
  } catch {
    return { ok: false, error: "aquifer returned non-JSON response" }
  }
}

/** GET /api/search — compact search across the reference corpus. */
export async function aquiferSearch(
  env: Env,
  query: string,
  opts: { lang?: string; limit?: number } = {},
): Promise<AquiferResult<AquiferSearchResponse>> {
  const q = (query ?? "").trim()
  if (!q) return { ok: false, error: "search query is empty" }
  const lang = opts.lang || "en"
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT)
  const url = `${baseUrl(env)}/api/search?q=${encodeURIComponent(q)}&lang=${encodeURIComponent(lang)}&limit=${limit}`
  const res = await cachedGet(url, env)
  if (!res.ok) return res
  return parseJson<AquiferSearchResponse>(res.data.text)
}

/** GET /api/page — a page's main content as plain text (markdown when the
 *  site supports format=md). Path is validated against the allowlist. */
export async function aquiferReadPage(
  env: Env,
  path: string,
  opts: { maxChars?: number } = {},
): Promise<AquiferResult<AquiferPage>> {
  const normalized = normalizeAquiferPath(path)
  if (!normalized) return { ok: false, error: `invalid aquifer path: ${String(path).slice(0, 80)}` }
  const maxChars = Math.min(Math.max(500, opts.maxChars ?? DEFAULT_PAGE_MAX_CHARS), 50_000)
  const url = `${baseUrl(env)}/api/page?path=${encodeURIComponent(normalized)}&max_chars=${maxChars}&format=md`
  const res = await cachedGet(url, env)
  if (!res.ok) return res
  return parseJson<AquiferPage>(res.data.text)
}

/** POST /api/answers — publish a researched Q&A back to the wiki. NOT cached.
 *  Callers gate this behind explicit user approval; it costs no user credits. */
export async function aquiferPublishAnswer(
  env: Env,
  payload: AquiferPublishPayload,
): Promise<AquiferResult<AquiferPublishResponse>> {
  if (!payload?.question || !payload?.answer) {
    return { ok: false, error: "publish requires question and answer" }
  }
  if (!Array.isArray(payload.citations) || payload.citations.length < 1) {
    return { ok: false, error: "publish requires at least one citation" }
  }
  const url = `${baseUrl(env)}/api/answers`
  const res = await fetchText(
    url,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    env,
  )
  if (!res.ok) return res
  return parseJson<AquiferPublishResponse>(res.data.text)
}
