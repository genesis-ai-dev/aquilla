// External similarity search (AQU-1232 — agent-memory retrieval).
//
//   GET /api/v1/external/projects/:projectId/similar?cellId=&limit=&cursor=
//   GET /api/v1/external/projects/:projectId/similar?text=&limit=&cursor=
//
// Purpose: "which cells read like this source line, and how were they
// rendered?" — so an agent can reuse the project's existing translations for a
// new line instead of inventing a fresh one. `search` answers "which cells
// contain these words"; this answers "which cells are most LIKE this one".
//
// **v1 is LEXICAL ONLY, by design.** Ranking is term overlap over the existing
// Postgres full-text column (`cells.value_tsv`) — no embeddings, no vector
// store, no new infrastructure. If semantic similarity is wanted later, that is
// a follow-up with its own infra decision; callers must not assume this route
// understands meaning, and the API map says so in as many words.
//
// Two-stage ranking:
//   1. SQL (`querySimilarSourceCells`) pulls a CANDIDATE POOL by ts_rank — the
//      cheap "does this share any terms at all" filter, scoped to the project.
//   2. JS (`lexicalSimilarity`) re-scores each candidate with a symmetric
//      Jaccard in [0, 1] and re-orders. ts_rank is unnormalized and rewards
//      length, so it is not a score a caller can threshold on or compare across
//      queries; Jaccard is. The pool is over-fetched (POOL_MULTIPLIER) so the
//      re-rank has something to reorder rather than just relabelling the SQL
//      order.
//
// PII: the response carries cell text only — no author, editor, or validator
// identity, and no timestamps that would let one be inferred. Reusing a
// rendering does not require knowing who wrote it.

import { makeVerifiedProjectId, querySimilarSourceCells } from "../events/scoped-search"
import { lexicalSimilarity } from "../lib/confidence/lexical-confidence"
import type { SyncTokenClaims } from "../auth"
import { externalError } from "./errors"
import { paginate, parsePageParams } from "./pagination"
import { authenticateAndScope, checkReadRateLimit, type ExternalReadsEnv } from "./read-auth"

export const SIMILAR_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/similar$/

/** Default page size — the ticket's "top-10 similar source cells". */
const DEFAULT_LIMIT = 10
/** Ceiling per page. Deliberately below the /search ceiling: every returned row
 *  drags a full source AND target value along with it. */
const MAX_LIMIT = 50
/** How many SQL candidates to pull per requested row before the JS re-rank.
 *  Without over-fetching, stage 2 could only reorder rows stage 1 already
 *  chose — the near-duplicate that ts_rank ranked 40th would never be seen. */
const POOL_MULTIPLIER = 5
/** Hard cap on the candidate pool, matching scoped-search's own MAX_LIMIT. */
const MAX_POOL = 500

export interface SimilarCellOut {
  cellId: string
  fileId: string
  sourceValue: string
  targetValue: string
  targetLang: string
  /** Symmetric lexical (Jaccard) similarity in [0, 1]; 1 = identical term sets. */
  score: number
}

/** Resolve the query text: either the source value of `cellId`, or `text`
 *  verbatim. Exactly one must be supplied. */
async function resolveQueryText(
  db: AquillaDb,
  projectId: string,
  url: URL,
): Promise<
  { ok: true; text: string; excludeCellId?: string } | { ok: false; response: Response }
> {
  const cellId = url.searchParams.get("cellId")
  const text = url.searchParams.get("text")

  if (cellId !== null && text !== null) {
    return {
      ok: false,
      response: externalError("validation_failed", "pass either cellId or text, not both", 400),
    }
  }

  if (cellId !== null) {
    if (cellId.trim() === "") {
      return { ok: false, response: externalError("validation_failed", "missing cellId", 400) }
    }
    const row = await db
      .prepare(
        "SELECT value FROM cells WHERE project_id = ? AND cell_id = ? AND side = 'source' LIMIT 1",
      )
      .bind(projectId, cellId)
      .first<{ value: string }>()
    if (!row) {
      return {
        ok: false,
        response: externalError("not_found", `no source cell ${cellId} in this project`, 404),
      }
    }
    // Exclude the query cell itself — a cell is trivially its own best match.
    return { ok: true, text: row.value, excludeCellId: cellId }
  }

  if (text === null || text.trim() === "") {
    return {
      ok: false,
      response: externalError("validation_failed", "missing cellId or text", 400),
    }
  }
  return { ok: true, text }
}

async function handleExternalSimilar(
  request: Request,
  env: ExternalReadsEnv,
  projectId: string,
): Promise<Response> {
  const authed = await authenticateAndScope(request, env, projectId)
  if (!authed.ok) return authed.response
  const db = env.AQUILLA_PG as AquillaDb

  const limited = await checkReadRateLimit(db, authed.ctx.credential.credentialId)
  if (limited) return limited

  const url = new URL(request.url)
  const resolved = await resolveQueryText(db, projectId, url)
  if (!resolved.ok) return resolved.response

  const { limit, offset } = parsePageParams(url, {
    defaultLimit: DEFAULT_LIMIT,
    maxLimit: MAX_LIMIT,
  })

  // makeVerifiedProjectId only accepts a SyncTokenClaims-shaped object — we
  // already established project scope + role above, so this claims object is
  // legitimate (not a bypass): it satisfies the branded-type gate that the
  // scoped-search choke-point requires, exactly as handleExternalSearch does.
  const claims: SyncTokenClaims = {
    userId: Number(authed.ctx.credential.userId),
    projectId,
    fileId: "",
    role: authed.ctx.role,
    aud: "sync",
    iat: 0,
    exp: 0,
  }

  const pool = Math.min(MAX_POOL, (offset + limit) * POOL_MULTIPLIER)
  const candidates = await querySimilarSourceCells(db, makeVerifiedProjectId(claims), resolved.text, {
    limit: pool,
    excludeCellId: resolved.excludeCellId,
  })

  const scored: SimilarCellOut[] = candidates
    .map((c) => ({
      cellId: c.cellId,
      fileId: c.fileId,
      sourceValue: c.sourceValue,
      targetValue: c.targetValue,
      targetLang: c.targetLang,
      score: lexicalSimilarity(resolved.text, c.sourceValue),
    }))
    .filter((c) => c.score > 0)
    // Tie-break on cellId so equal-scoring rows paginate deterministically —
    // this is offset pagination (see pagination.ts), which an unstable sort
    // would turn into duplicated/skipped rows across pages.
    .sort((a, b) => b.score - a.score || a.cellId.localeCompare(b.cellId))

  return Response.json(paginate(scored, offset, limit))
}

/** Router entry. Returns null when the path/method is not ours. */
export async function handleExternalSimilarRequest(
  request: Request,
  env: ExternalReadsEnv,
): Promise<Response | null> {
  if (request.method !== "GET") return null
  const match = new URL(request.url).pathname.match(SIMILAR_RE)
  if (!match) return null
  return handleExternalSimilar(request, env, decodeURIComponent(match[1]))
}
