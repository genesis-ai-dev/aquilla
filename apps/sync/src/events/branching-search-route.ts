// AD-13 branching-search read route.
//
//   GET /api/v1/projects/:projectId/branching-search
//     ?q=<query text>
//     [&topK=<n>]                — overrides project_settings.topK; capped at MAX_TOP_K
//     [&validatedOnly=true]      — AI copilot filter: only return cells with a validated target
//     [&excludeCellId=<uuid>]    — don't return this cell (the one the copilot is completing)
//
// Auth: sync-token JWT scoped to `projectId`. Viewer (100)+.
//
// Corpus selection (AD-9):
//   - Self-contained:  this project's source cells.
//   - Source-only:     this project's source cells, target_text empty.
//   - Linked target:   upstream project's source cells, target_text from
//                      this project's own target rows.
//
// Tunables (AD-13):
//   - Precedence on the route: defaults < project_settings.branchingSearch
//     < query-string override. The AI copilot may pass `topK` per-call;
//     project_settings provides per-project tuning; defaults apply when
//     neither is set.
//
// Caching: not implemented in v1. Spec says results are cacheable by
// `(project_id, query_hash, corpus_event_max)` — that requires a KV
// binding we don't yet have. See `corpusEventMax` in the response — it's
// the cache key when caching lands.

import { verifyTokenForProject } from "../auth"
import { branchingSearch } from "../lib/branching-search/algorithm"
import { loadCorpus } from "../lib/branching-search/corpus"
import {
  applyBranchingSearchDefaults,
  loadBranchingSearchSettings,
} from "../lib/branching-search/settings"

export interface BranchingSearchEnv {
  AQUILLA_DB?: D1Database
  SYNC_SECRET_KEY?: string
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/branching-search$/

/** Upper bound on topK to prevent runaway queries. The default is 5;
 *  any reasonable copilot/decay use case stays well under this. */
const MAX_TOP_K = 50

export interface BranchingSearchResponseResult {
  cellId: string
  sourceText: string
  targetText: string
  queryCoverage: number
}

export interface BranchingSearchResponse {
  results: BranchingSearchResponseResult[]
  /** cellId → contiguous words from the winning branch that this result satisfied. */
  provenance: Record<string, string[]>
  /** Resolved upstream id; null for self-contained / source-only. */
  upstreamProjectId: string | null
  /** Max source-side event_id observed in the corpus — cache key seed. */
  corpusEventMax: string | null
  /** Number of cells in the corpus that the query ran over. */
  corpusSize: number
}

export async function handleBranchingSearchRequest(
  request: Request,
  env: BranchingSearchEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const match = url.pathname.match(PATH_RE)
  if (!match) return null
  if (request.method !== "GET") return null

  if (!env.SYNC_SECRET_KEY) {
    return new Response("SYNC_SECRET_KEY not configured", { status: 500 })
  }
  if (!env.AQUILLA_DB) {
    return new Response("AQUILLA_DB binding not configured", { status: 500 })
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

  // Settings layering: defaults < project_settings.branchingSearch <
  // query-string override. AD-14 endorsement will use the same loader so
  // the AI copilot and decay bookkeeping never diverge.
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
    return new Response(`corpus load failed: ${message}`, { status: 500 })
  }

  const { results, provenance } = branchingSearch(q, corpus.cells, settings)

  const provObj: Record<string, string[]> = {}
  for (const [cellId, tokens] of provenance) provObj[cellId] = tokens

  const body: BranchingSearchResponse = {
    results,
    provenance: provObj,
    upstreamProjectId: corpus.upstreamProjectId,
    corpusEventMax: corpus.corpusEventMax,
    corpusSize: corpus.cells.length,
  }
  return Response.json(body)
}
