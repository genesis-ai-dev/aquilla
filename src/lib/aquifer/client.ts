/**
 * aquifer/client.ts — browser client for the Bible Aquifer reference routes.
 *
 * Mounted server-side at /api/v1/aquifer on the SAME auth-worker origin as the
 * project-settings and agent routes, so the base URL + Bearer-JWT auth pattern
 * mirrors src/lib/sync/project-settings.ts (FRONTIER_API_URL + `Bearer ${jwt}`).
 *
 * All three routes require a `projectId` and 404 when the project hasn't
 * enabled the `bibleResourcesEnabled` feature; they consume NO credits.
 *
 * `page.text` is PLAIN TEXT today (newlines, no markdown). Consumers render it
 * with `whitespace-pre-wrap`; see SearchDockPanel for the markdown-ready seam.
 */

import { FRONTIER_API_URL } from "@/lib/sync/sync-token"

// ── Wire shapes (mirror auth-worker/src/lib/aquifer) ───────────────────────

export type AquiferResultKind =
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

export interface AquiferSearchResult {
  title: string
  url: string
  kind: AquiferResultKind
  description: string
}

export interface AquiferSearchResponse {
  query: string
  lang: string
  count: number
  results: AquiferSearchResult[]
}

export interface AquiferPageResponse {
  path: string
  url: string
  title: string
  truncated: boolean
  /** PLAIN TEXT today — newlines, no markdown. */
  text: string
}

export interface AquiferAnswerCitation {
  url: string
  title?: string
  quote?: string
}

export interface AquiferPublishAnswerPayload {
  question: string
  answer: string
  status: string
  citations: AquiferAnswerCitation[]
}

export interface AquiferPublishAnswerResponse {
  url: string
}

/** Thrown on any non-2xx response so callers can surface the status + message. */
export class AquiferError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "AquiferError"
    this.status = status
  }
}

function authHeaders(jwt: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`,
  }
}

async function readError(res: Response): Promise<AquiferError> {
  const text = await res.text().catch(() => "")
  return new AquiferError(res.status, text || res.statusText || "Aquifer request failed")
}

const BASE = `${FRONTIER_API_URL}/api/v1/aquifer`

export interface AquiferSearchOptions {
  lang?: string
  limit?: number
  signal?: AbortSignal
}

/** GET /api/v1/aquifer/search — scholarly reference lookup. */
export async function aquiferSearch(
  jwt: string,
  projectId: string,
  q: string,
  opts: AquiferSearchOptions = {},
): Promise<AquiferSearchResponse> {
  const params = new URLSearchParams({ projectId, q })
  if (opts.lang) params.set("lang", opts.lang)
  if (opts.limit != null) params.set("limit", String(opts.limit))
  const res = await fetch(`${BASE}/search?${params.toString()}`, {
    headers: authHeaders(jwt),
    signal: opts.signal,
  })
  if (!res.ok) throw await readError(res)
  return (await res.json()) as AquiferSearchResponse
}

export interface AquiferReadPageOptions {
  maxChars?: number
  signal?: AbortSignal
}

/** GET /api/v1/aquifer/page — render one site path as plain text. */
export async function aquiferReadPage(
  jwt: string,
  projectId: string,
  path: string,
  opts: AquiferReadPageOptions = {},
): Promise<AquiferPageResponse> {
  const params = new URLSearchParams({ projectId, path })
  if (opts.maxChars != null) params.set("maxChars", String(opts.maxChars))
  const res = await fetch(`${BASE}/page?${params.toString()}`, {
    headers: authHeaders(jwt),
    signal: opts.signal,
  })
  if (!res.ok) throw await readError(res)
  return (await res.json()) as AquiferPageResponse
}

/** POST /api/v1/aquifer/answers — publish an agent answer proposal as a wiki page. */
export async function aquiferPublishAnswer(
  jwt: string,
  projectId: string,
  payload: AquiferPublishAnswerPayload,
): Promise<AquiferPublishAnswerResponse> {
  const res = await fetch(`${BASE}/answers`, {
    method: "POST",
    headers: authHeaders(jwt),
    body: JSON.stringify({ projectId, ...payload }),
  })
  if (!res.ok) throw await readError(res)
  return (await res.json()) as AquiferPublishAnswerResponse
}
