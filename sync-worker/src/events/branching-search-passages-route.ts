// AD-13 branching-search PASSAGES route.
//
//   GET /api/v1/projects/:projectId/branching-search/passages
//     ?q=<query>[&topK=N][&radius=N][&validatedOnly=true][&excludeCellId=<uuid>]
//
// Same retrieval as the flat `/branching-search` route, then expands each
// top-K hit into a passage of ±radius cells from the same file via the
// anchor chain. Used by the AI copilot's batch path so the LLM sees
// contiguous source/target context around each retrieved hit (the
// passage), not just the isolated hit cell.
//
// Auth, settings layering, corpus selection (AD-9), and the algorithm
// itself are identical to `/branching-search`. Only the output shape
// differs.
//
// Caching: shared KV cache with the flat route would require an output-
// shape discriminator in the key. Passages mode is not cached in v1; the
// extra ±radius walk runs every call. (Cache is added when AD-14 decay
// endorsement makes the load profile a real concern.)

import { verifyTokenForProject } from "../auth"
import { branchingSearch } from "../lib/branching-search/algorithm"
import { loadCorpus } from "../lib/branching-search/corpus"
import {
  applyBranchingSearchDefaults,
  loadBranchingSearchSettings,
} from "../lib/branching-search/settings"
import { expandToPassages, type Passage } from "../lib/branching-search/passages"

export interface BranchingSearchPassagesEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

const PATH_RE =
  /^\/api\/v1\/projects\/([^/]+)\/branching-search\/passages$/

const MAX_TOP_K = 50
const MAX_RADIUS = 10
const DEFAULT_RADIUS = 2

export interface BranchingSearchPassagesResponse {
  passages: Passage[]
  upstreamProjectId: string | null
  corpusEventMax: string | null
  corpusSize: number
}

export async function handleBranchingSearchPassagesRequest(
  request: Request,
  env: BranchingSearchPassagesEnv,
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
  if (!auth.ok) return new Response(auth.reason, { status: auth.status })

  const q = url.searchParams.get("q")
  if (q === null || q.trim() === "") {
    return new Response("missing q", { status: 400 })
  }

  let settings = await loadBranchingSearchSettings(env, projectId)

  const qTopK = url.searchParams.get("topK")
  if (qTopK !== null) {
    const parsed = parseInt(qTopK, 10)
    if (!isNaN(parsed)) {
      settings = applyBranchingSearchDefaults({
        ...settings,
        topK: Math.min(MAX_TOP_K, Math.max(1, parsed)),
      })
    }
  }

  let radius = DEFAULT_RADIUS
  const qRadius = url.searchParams.get("radius")
  if (qRadius !== null) {
    const parsed = parseInt(qRadius, 10)
    if (!isNaN(parsed)) {
      radius = Math.min(MAX_RADIUS, Math.max(0, parsed))
    }
  }

  const validatedOnly = url.searchParams.get("validatedOnly") === "true"
  const excludeCellId = url.searchParams.get("excludeCellId") ?? undefined

  let corpus
  try {
    corpus = await loadCorpus(env, {
      projectId,
      validatedOnly,
      excludeCellId,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('corpus load failed:', message)
    return new Response('corpus load failed', { status: 500 })
  }

  const { results } = branchingSearch(q, corpus.cells, settings)
  const passages = expandToPassages(
    corpus.cells,
    results.map((r) => r.cellId),
    radius,
  )

  const body: BranchingSearchPassagesResponse = {
    passages,
    upstreamProjectId: corpus.upstreamProjectId,
    corpusEventMax: corpus.corpusEventMax,
    corpusSize: corpus.cells.length,
  }
  return Response.json(body)
}
