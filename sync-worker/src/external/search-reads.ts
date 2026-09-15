// External full-text search routes (AGENT-API §4 read tier).
//
//   GET /api/v1/external/projects/:projectId/search?q=&side=&limit=&cursor=
//   GET /api/v1/external/search?q=&projectIds=a,b&side=&limit=&cursor=   (AQU-1236)
//
// The cross-project form exists because a console managing a partner's whole
// workspace previously had to issue one request (and hold one token) per
// project to answer "where does this term appear?". It takes an EXPLICIT project
// list rather than implicitly searching everything the credential can reach:
// fan-out cost should be something the caller asked for, not a surprise.
//
// Both forms run the same per-project gate (read-auth.ts) and the same single
// structural choke-point for project-scoped FTS (scoped-search.ts's
// queryScopedSearch) — there is no second search implementation here.
//
// Scoping is STRICT, not best-effort: if any requested project is unknown, out
// of the credential's scope, or one the caller has no membership on, the whole
// call fails with the same code the single-project route would return for it.
// Silently dropping such a project would let a caller probe which ids exist by
// diffing the result set, and would make a partial answer indistinguishable
// from a complete one.

import type { SyncTokenClaims } from "../auth"
import { makeVerifiedProjectId, queryScopedSearch } from "../events/scoped-search"
import type { SearchResultOut } from "../events/scoped-search"
import { externalError } from "./errors"
import { paginate, parsePageParams } from "./pagination"
import {
  authenticateCredential,
  authenticateAndScope,
  checkSearchRateLimit,
  scopeCredentialToProject,
  type AuthedContext,
  type ExternalReadsEnv,
} from "./read-auth"

/** Upper bound on projects per cross-project search. Each one is an independent
 *  FTS query, so the fan-out is the cost driver — bounded here so a single
 *  request cannot turn into an unbounded scan of a large org. */
export const MAX_SEARCH_PROJECTS = 10

interface ParsedSearchQuery {
  q: string
  side?: "source" | "target"
}

/** Parse + validate the shared `q` / `side` params. */
function parseSearchQuery(url: URL): ParsedSearchQuery | Response {
  const q = url.searchParams.get("q")
  if (q === null || q.trim() === "") {
    return externalError("validation_failed", "missing q", 400)
  }

  const qSide = url.searchParams.get("side")
  if (qSide !== null) {
    if (qSide !== "source" && qSide !== "target") {
      return externalError("validation_failed", "invalid side: must be source or target", 400)
    }
    return { q, side: qSide }
  }
  return { q }
}

/**
 * Run one project's FTS query. `ctx` must come from a gate that already
 * established project scope + role.
 *
 * makeVerifiedProjectId only accepts a SyncTokenClaims-shaped object — the
 * claims built here are legitimate (not a bypass): they satisfy the branded-type
 * gate queryScopedSearch requires, the same way search-route.ts's real JWT
 * claims do, using the role the gate already resolved.
 */
async function runOneProjectSearch(
  db: AquillaDb,
  ctx: AuthedContext,
  projectId: string,
  parsed: ParsedSearchQuery,
  fetchLimit: number,
): Promise<SearchResultOut[]> {
  const claims: SyncTokenClaims = {
    userId: Number(ctx.credential.userId),
    projectId,
    fileId: "",
    role: ctx.role,
    aud: "sync",
    iat: 0,
    exp: 0,
  }
  return queryScopedSearch(db, makeVerifiedProjectId(claims), parsed.q, {
    side: parsed.side,
    limit: fetchLimit,
  })
}

/** Map an FTS failure to the external error envelope. */
function searchFailure(err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err)
  console.error("external search failed:", err)
  if (/syntax error|fts5/i.test(message)) {
    return externalError("validation_failed", "invalid search query", 400)
  }
  return externalError("validation_failed", "search failed", 400)
}

// ---------------------------------------------------------------------------
// GET /api/v1/external/projects/:projectId/search
// ---------------------------------------------------------------------------

export async function handleExternalSearch(
  request: Request,
  env: ExternalReadsEnv,
  projectId: string,
): Promise<Response> {
  const authed = await authenticateAndScope(request, env, projectId)
  if (!authed.ok) return authed.response

  if (env.AQUILLA_PG) {
    const limited = await checkSearchRateLimit(env.AQUILLA_PG, authed.ctx.credential.credentialId)
    if (limited) return limited
  }

  const url = new URL(request.url)
  const parsed = parseSearchQuery(url)
  if (parsed instanceof Response) return parsed

  const { limit, offset } = parsePageParams(url)

  // queryScopedSearch only supports limit (no offset) — over-fetch to
  // offset+limit (capped at its own MAX_LIMIT=500) and paginate in memory.
  // See pagination.ts's module doc for the offset-pagination caveat this implies.
  const fetchLimit = Math.min(500, offset + limit)

  try {
    const results = await runOneProjectSearch(
      env.AQUILLA_PG as AquillaDb,
      authed.ctx,
      projectId,
      parsed,
      fetchLimit,
    )
    return Response.json(paginate(results, offset, limit))
  } catch (err) {
    return searchFailure(err)
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/external/search?projectIds=a,b  (AQU-1236 cross-project)
// ---------------------------------------------------------------------------

/** One cross-project hit: a single-project result plus the project it came
 *  from, so a merged list stays attributable without a second lookup. */
export interface CrossProjectSearchResult extends SearchResultOut {
  projectId: string
}

/** Parse the required `projectIds` list (comma-separated, deduped, order
 *  preserved — the response's per-project ordering follows it). */
function parseProjectIds(url: URL): string[] | Response {
  const raw = url.searchParams.get("projectIds")
  if (raw === null || raw.trim() === "") {
    return externalError(
      "validation_failed",
      "missing projectIds — pass a comma-separated list of project ids to search",
      400,
    )
  }
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter((s) => s !== ""))]
  if (ids.length === 0) {
    return externalError("validation_failed", "projectIds contained no project ids", 400)
  }
  if (ids.length > MAX_SEARCH_PROJECTS) {
    return externalError(
      "validation_failed",
      `too many projects: ${ids.length} requested, max ${MAX_SEARCH_PROJECTS} per call`,
      400,
    )
  }
  return ids
}

export async function handleExternalCrossProjectSearch(
  request: Request,
  env: ExternalReadsEnv,
): Promise<Response> {
  if (!env.AQUILLA_PG) return externalError("job_failed", "AQUILLA_PG not configured", 500)

  const url = new URL(request.url)
  const projectIds = parseProjectIds(url)
  if (projectIds instanceof Response) return projectIds

  const parsed = parseSearchQuery(url)
  if (parsed instanceof Response) return parsed

  const authed = await authenticateCredential(request, env)
  if (!authed.ok) return authed.response

  // Charged per project searched — see checkSearchRateLimit's `cost`.
  const limited = await checkSearchRateLimit(
    env.AQUILLA_PG,
    authed.credential.credentialId,
    projectIds.length,
  )
  if (limited) return limited

  // Gate EVERY project before searching ANY of them, so a partially-authorized
  // list produces no results at all rather than a partial leak.
  const contexts: { projectId: string; ctx: AuthedContext }[] = []
  for (const projectId of projectIds) {
    const scoped = await scopeCredentialToProject(env, authed.credential, projectId)
    if (!scoped.ok) return scoped.response
    contexts.push({ projectId, ctx: scoped.ctx })
  }

  const { limit, offset } = parsePageParams(url)
  // Over-fetch per project so the merged list can still be paginated in memory
  // (same offset caveat as the single-project route).
  const fetchLimit = Math.min(500, offset + limit)

  const merged: CrossProjectSearchResult[] = []
  for (const { projectId, ctx } of contexts) {
    try {
      const results = await runOneProjectSearch(
        env.AQUILLA_PG,
        ctx,
        projectId,
        parsed,
        fetchLimit,
      )
      for (const r of results) merged.push({ ...r, projectId })
    } catch (err) {
      return searchFailure(err)
    }
  }

  // Rank is FTS5 bm25 (more negative = better), comparable across projects
  // because every project's index is built the same way. projectId breaks ties
  // so the ordering is stable for a paginating caller.
  merged.sort((a, b) => (a.rank === b.rank ? a.projectId.localeCompare(b.projectId) : a.rank - b.rank))

  return Response.json({
    ...paginate(merged, offset, limit),
    projectIds: contexts.map((c) => c.projectId),
  })
}
