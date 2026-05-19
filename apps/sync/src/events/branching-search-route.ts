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
// Caching: result responses are cached on the optional KV binding
// `BRANCHING_SEARCH_KV` per spec — key includes `corpus_event_max` so an
// upstream source edit naturally invalidates without explicit purge. The
// cache is opt-in by binding presence; without the binding the route runs
// the algorithm fresh on every request. See lib/branching-search/cache.ts
// for provisioning instructions.

import { verifyTokenForProject } from "../auth"
import { branchingSearch } from "../lib/branching-search/algorithm"
import { loadCorpus, resolveUpstreamProjectId } from "../lib/branching-search/corpus"
import {
  applyBranchingSearchDefaults,
  loadBranchingSearchSettings,
} from "../lib/branching-search/settings"
import {
  buildCacheKey,
  CACHE_TTL_SECONDS,
  hashQueryParams,
  resolveCorpusEventMax,
} from "../lib/branching-search/cache"

export interface BranchingSearchEnv {
  AQUILLA_DB?: D1Database
  SYNC_SECRET_KEY?: string
  /** Optional. When bound, GET responses are cached by
   *  `(projectId, corpusEventMax, queryHash)` with a 60s TTL. Absence
   *  disables the cache; behavior is otherwise identical. */
  BRANCHING_SEARCH_KV?: KVNamespace
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

  // Cache lookup. Build the key from a cheap MAX(event_id) query — we
  // can't use the corpus loader's corpusEventMax here because the corpus
  // load is the expensive step we're trying to skip. Cache is opt-in by
  // binding presence; on any failure we soft-fail through to the
  // uncached path.
  let cacheKey: string | null = null
  if (env.BRANCHING_SEARCH_KV) {
    try {
      const upstream = await resolveUpstreamProjectId(env, projectId)
      const sourceProjectId = upstream ?? projectId
      const corpusEventMax = await resolveCorpusEventMax(env, sourceProjectId)
      if (corpusEventMax) {
        const queryHash = await hashQueryParams({
          q,
          topK: settings.topK,
          validatedOnly,
          excludeCellId: excludeCellId ?? null,
        })
        cacheKey = buildCacheKey(projectId, corpusEventMax, queryHash)
        const cached = await env.BRANCHING_SEARCH_KV.get(cacheKey, "json")
        if (cached) {
          return Response.json(cached)
        }
      }
    } catch {
      // Cache lookup failure must not break retrieval. Fall through.
      cacheKey = null
    }
  }

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

  // Cache write. Synchronous because the route handler doesn't get an
  // ExecutionContext; this adds ~5-10ms but is a small price for the
  // simplicity. Failures don't surface — cache is best-effort.
  if (cacheKey && env.BRANCHING_SEARCH_KV) {
    try {
      await env.BRANCHING_SEARCH_KV.put(cacheKey, JSON.stringify(body), {
        expirationTtl: CACHE_TTL_SECONDS,
      })
    } catch {
      // best-effort
    }
  }

  return Response.json(body)
}
