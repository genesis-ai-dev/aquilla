// Project-wide cell search (Phase 2b). FTS5-backed.
//
//   GET /api/v1/projects/:projectId/search?q=&side=&limit=
//   GET /api/v1/projects/:projectId/search/passages?q=&side=&limit=
//
// Query params (both routes):
//   q     — required, the user's search text. Sanitized before hitting FTS5.
//   side  — optional. "source" | "target". Filters to one side of the
//           paired cells. When omitted, both sides are returned.
//   limit — optional. Default 50, max 500.
//
// /search returns:
//   { results: [{ cellId, fileId, side, value, snippet, rank }] }
//
// /search/passages additionally returns the opposite-side cell value:
//   { results: [{ cellId, fileId, side, value, snippet, rank, pairedValue }] }
//
// Auth: sync-token JWT scoped to `projectId`; minimum role viewer (100).
//
// SQL is not emitted here — all FTS5 execution is delegated to scoped-search.ts,
// which is the single structural choke-point for project-scoped FTS queries.

import { verifyTokenForProject } from "../auth"
import {
  makeVerifiedProjectId,
  queryScopedSearch,
  queryScopedExact,
  // Re-exported so existing tests importing sanitizeFtsQuery from this module
  // continue to compile without modification (Task 7 will migrate them).
  sanitizeFtsQuery,
} from "./scoped-search"

export type { SearchResultOut, ParallelPassageRow } from "./scoped-search"

// Re-export sanitizeFtsQuery so the existing test suite (which imports it
// from this module) keeps working until Task 7 updates the imports.
export { sanitizeFtsQuery }

export interface SearchReadEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

// /search must be anchored with $ so it does NOT match /search/passages.
// Both regexes capture the projectId in group 1.
const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/search$/
const PASSAGES_PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/search\/passages$/

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Parse and validate the common query params (side, limit) shared by both
 * search routes. Returns a 400 Response on invalid input, or the parsed
 * values on success.
 */
function parseCommonParams(
  url: URL,
): { error: Response } | { sideFilter: "source" | "target" | undefined; limit: number } {
  const qSide = url.searchParams.get("side")
  let sideFilter: "source" | "target" | undefined = undefined
  if (qSide !== null) {
    if (qSide !== "source" && qSide !== "target") {
      return { error: new Response("invalid side: must be source or target", { status: 400 }) }
    }
    sideFilter = qSide
  }

  let limit = DEFAULT_LIMIT
  const qLimit = url.searchParams.get("limit")
  if (qLimit !== null) {
    const parsed = parseInt(qLimit, 10)
    if (!isNaN(parsed)) {
      limit = Math.min(MAX_LIMIT, Math.max(1, parsed))
    }
  }

  return { sideFilter, limit }
}

/**
 * Map a caught DB error to a Response. FTS5 syntax errors become 400; all
 * other failures become 500.
 */
function mapSearchError(err: unknown): Response {
  // FTS5 syntax errors (e.g. the user wrote `"` un-balanced before our
  // sanitizer rolled out) surface as Postgres prepare/exec failures. Surface
  // them as a 400 rather than 500 so the client can fall back to a
  // "no results" UI instead of an error banner.
  const message = err instanceof Error ? err.message : String(err)
  if (/syntax error|fts5/i.test(message)) {
    return new Response(`invalid search query: ${message}`, { status: 400 })
  }
  return new Response(`search failed: ${message}`, { status: 500 })
}

// ---------------------------------------------------------------------------
// GET /api/v1/projects/:projectId/search
// ---------------------------------------------------------------------------

export async function handleSearchReadRequest(
  request: Request,
  env: SearchReadEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(PATH_RE)
  if (!match) return null
  if (request.method !== "GET") return null

  if (!env.SYNC_SECRET_KEY) {
    return new Response("SYNC_SECRET_KEY not configured", { status: 500 })
  }
  if (!env.AQUILLA_PG) {
    return new Response("AQUILLA_PG binding not configured", { status: 500 })
  }

  const projectId = decodeURIComponent(match[1])

  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  if (!token) {
    return new Response("missing Authorization header", { status: 401 })
  }

  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) {
    return new Response(auth.reason, { status: auth.status })
  }

  // Build the structural permission gate: VerifiedProjectId can only come
  // from verified JWT claims, and queryScopedSearch only accepts that type.
  const verifiedProjectId = makeVerifiedProjectId(auth.claims)

  const q = url.searchParams.get("q")
  if (q === null || q.trim() === "") {
    return new Response("missing q", { status: 400 })
  }

  const parsed = parseCommonParams(url)
  if ("error" in parsed) return parsed.error
  const { sideFilter, limit } = parsed

  try {
    const results = await queryScopedSearch(env.AQUILLA_PG, verifiedProjectId, q, {
      side: sideFilter,
      limit,
    })
    return Response.json({ results })
  } catch (err) {
    return mapSearchError(err)
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/projects/:projectId/search/passages
// ---------------------------------------------------------------------------

export async function handleSearchPassagesRequest(
  request: Request,
  env: SearchReadEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(PASSAGES_PATH_RE)
  if (!match) return null
  if (request.method !== "GET") return null

  if (!env.SYNC_SECRET_KEY) {
    return new Response("SYNC_SECRET_KEY not configured", { status: 500 })
  }
  if (!env.AQUILLA_PG) {
    return new Response("AQUILLA_PG binding not configured", { status: 500 })
  }

  const projectId = decodeURIComponent(match[1])

  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  if (!token) {
    return new Response("missing Authorization header", { status: 401 })
  }

  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) {
    return new Response(auth.reason, { status: auth.status })
  }

  // Same structural permission gate as the ranked-search route.
  const verifiedProjectId = makeVerifiedProjectId(auth.claims)

  const q = url.searchParams.get("q")
  if (q === null || q.trim() === "") {
    return new Response("missing q", { status: 400 })
  }

  const parsed = parseCommonParams(url)
  if ("error" in parsed) return parsed.error
  const { sideFilter, limit } = parsed

  try {
    const results = await queryScopedExact(env.AQUILLA_PG, verifiedProjectId, q, {
      side: sideFilter,
      limit,
    })
    return Response.json({ results })
  } catch (err) {
    return mapSearchError(err)
  }
}
