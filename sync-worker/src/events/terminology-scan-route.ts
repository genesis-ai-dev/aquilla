// AQU-1192
//
//   GET /api/v1/projects/:projectId/terminology/violations
//   GET /api/v1/projects/:projectId/terminology/candidates
//   GET /api/v1/projects/:projectId/concepts/:conceptId/suggestions
//
// Auth matches the concepts read: a sync-token scoped to this project, viewer
// or above. Each response is the scan result, not the project's cells.

import { verifyTokenForProject } from "../auth"
import {
  queryConceptSuggestions,
  queryTerminologyCandidates,
  queryTerminologyViolations,
} from "./terminology-scan"

export interface TerminologyScanEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

const VIOLATIONS_RE = /^\/api\/v1\/projects\/([^/]+)\/terminology\/violations$/
const CANDIDATES_RE = /^\/api\/v1\/projects\/([^/]+)\/terminology\/candidates$/
const SUGGESTIONS_RE = /^\/api\/v1\/projects\/([^/]+)\/concepts\/([^/]+)\/suggestions$/

export async function handleTerminologyScanRequest(
  request: Request,
  env: TerminologyScanEnv,
): Promise<Response | null> {
  if (request.method !== "GET") return null
  const url = new URL(request.url)
  const violations = url.pathname.match(VIOLATIONS_RE)
  const candidates = url.pathname.match(CANDIDATES_RE)
  const suggestions = url.pathname.match(SUGGESTIONS_RE)
  if (!violations && !candidates && !suggestions) return null

  if (!env.SYNC_SECRET_KEY) return new Response("SYNC_SECRET_KEY not configured", { status: 500 })
  if (!env.AQUILLA_PG) return new Response("AQUILLA_PG binding not configured", { status: 500 })

  const projectId = decodeURIComponent((violations ?? candidates ?? suggestions)![1])
  const token = (request.headers.get("Authorization") ?? "").startsWith("Bearer ")
    ? (request.headers.get("Authorization") ?? "").slice(7)
    : null
  if (!token) return new Response("missing Authorization header", { status: 401 })

  const auth = await verifyTokenForProject(token, projectId, env.SYNC_SECRET_KEY)
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })

  const lane = url.searchParams.get("lane") ?? ""
  try {
    if (violations) {
      return Response.json(await queryTerminologyViolations(env.AQUILLA_PG, projectId, lane))
    }
    if (candidates) {
      return Response.json(await queryTerminologyCandidates(env.AQUILLA_PG, projectId))
    }
    const conceptId = decodeURIComponent(suggestions![2])
    const page = await queryConceptSuggestions(env.AQUILLA_PG, projectId, conceptId, lane)
    if (!page) return new Response("concept not found", { status: 404 })
    return Response.json(page)
  } catch (err) {
    console.error("terminology scan failed:", err instanceof Error ? err.message : String(err))
    return new Response("terminology scan failed", { status: 500 })
  }
}
