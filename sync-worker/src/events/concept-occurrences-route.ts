// AQU-1192
//
//   GET /api/v1/projects/:projectId/concepts/:conceptId/occurrences?offset=&limit=&lane=
//
// Returns one page of source cells the concept's matcher accepts, paired with
// the target text of `lane` (default ''). Auth matches the concepts read:
// a sync-token scoped to this project, viewer or above.

import { verifyTokenForProject } from "../auth"
import { loadConceptForOccurrences, queryConceptOccurrences } from "./concept-occurrences"

export interface ConceptOccurrencesEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/concepts\/([^/]+)\/occurrences$/
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 200

function parsePaging(url: URL): { error: Response } | { offset: number; limit: number; lane: string } {
  let limit = DEFAULT_LIMIT
  const qLimit = url.searchParams.get("limit")
  if (qLimit !== null) {
    const parsed = Number(qLimit)
    if (!Number.isInteger(parsed) || parsed < 1) {
      return { error: new Response("invalid limit", { status: 400 }) }
    }
    limit = Math.min(MAX_LIMIT, parsed)
  }
  let offset = 0
  const qOffset = url.searchParams.get("offset")
  if (qOffset !== null) {
    const parsed = Number(qOffset)
    if (!Number.isInteger(parsed) || parsed < 0) {
      return { error: new Response("invalid offset", { status: 400 }) }
    }
    offset = parsed
  }
  return { offset, limit, lane: url.searchParams.get("lane") ?? "" }
}

export async function handleConceptOccurrencesRequest(
  request: Request,
  env: ConceptOccurrencesEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(PATH_RE)
  if (!match || request.method !== "GET") return null

  if (!env.SYNC_SECRET_KEY) return new Response("SYNC_SECRET_KEY not configured", { status: 500 })
  if (!env.AQUILLA_PG) return new Response("AQUILLA_PG binding not configured", { status: 500 })

  const projectId = decodeURIComponent(match[1])
  const conceptId = decodeURIComponent(match[2])
  const token = (request.headers.get("Authorization") ?? "").startsWith("Bearer ")
    ? (request.headers.get("Authorization") ?? "").slice(7)
    : null
  if (!token) return new Response("missing Authorization header", { status: 401 })

  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })

  const paging = parsePaging(url)
  if ("error" in paging) return paging.error

  try {
    const loaded = await loadConceptForOccurrences(env.AQUILLA_PG, projectId, conceptId)
    if (!loaded) return new Response("concept not found", { status: 404 })
    const page = await queryConceptOccurrences(
      env.AQUILLA_PG,
      projectId,
      loaded.concept,
      loaded.termMatching,
      paging,
    )
    return Response.json(page)
  } catch (err) {
    console.error("concept occurrences failed:", err instanceof Error ? err.message : String(err))
    return new Response("concept occurrences failed", { status: 500 })
  }
}
