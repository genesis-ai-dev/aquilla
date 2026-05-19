// AD-13 corpus loader — reads source-side cells for the project, with
// AD-9 upstream COALESCE so linked-target projects retrieve against
// their upstream source corpus.
//
// One query handles all three project shapes:
//   - Self-contained:  source + target in the same project → both sides come
//                      from `projectId` via COALESCE(null, projectId)
//   - Source-only:     source in `projectId`, no target → LEFT JOIN
//                      contributes empty target_text
//   - Linked target:   source from `upstreamProjectId`, target from
//                      `projectId` (this project's own targets, paired
//                      with the upstream's sources by cell_id)

import type { CorpusCell } from "./algorithm"

export interface CorpusLoaderEnv {
  AQUILLA_DB?: D1Database
}

/**
 * Resolves the upstream project id (or `null` for self-contained / source-only).
 * Defensive: AD-9's `projects.source_project_id` column was added in
 * migration 0004; older deployments may not have it. Treat the absence
 * as "self-contained" — matches the stale-source-route's behavior.
 */
export async function resolveUpstreamProjectId(
  env: CorpusLoaderEnv,
  projectId: string,
): Promise<string | null> {
  if (!env.AQUILLA_DB) return null
  try {
    const row = await env.AQUILLA_DB.prepare(
      "SELECT source_project_id FROM projects WHERE id = ?",
    )
      .bind(projectId)
      .first<{ source_project_id: string | null }>()
    return row?.source_project_id ?? null
  } catch {
    return null
  }
}

export interface LoadCorpusArgs {
  projectId: string
  /** If provided, restricts the corpus to the cells of `t.validated = 1`. */
  validatedOnly?: boolean
  /** If provided, excludes this cellId from the corpus (e.g., the cell the
   *  copilot is currently completing — we don't want it to retrieve itself). */
  excludeCellId?: string
}

export interface LoadCorpusResult {
  cells: CorpusCell[]
  /** Resolved upstream id — null for self-contained / source-only projects.
   *  Returned so the caller can include it in the response (callers might
   *  want to badge results "from upstream X"). */
  upstreamProjectId: string | null
  /** Max event_id seen across the loaded corpus (lexicographic on UUIDv7).
   *  Useful as a cache key — `(projectId, query_hash, corpusEventMax)`. */
  corpusEventMax: string | null
}

/**
 * Loads the AD-13 branching-search corpus. See file-level comment for the
 * three project-shape behaviors. Throws on D1 errors; the route handler
 * surfaces them as 500. (Unlike `stale-source-route` which soft-fails to
 * empty, the corpus is fundamental to this endpoint — a missing one is
 * an error, not "no neighbors.")
 */
export async function loadCorpus(
  env: CorpusLoaderEnv,
  args: LoadCorpusArgs,
): Promise<LoadCorpusResult> {
  if (!env.AQUILLA_DB) {
    return { cells: [], upstreamProjectId: null, corpusEventMax: null }
  }

  const upstreamProjectId = await resolveUpstreamProjectId(env, args.projectId)

  // Single query: source from `COALESCE(upstream, projectId)`, target
  // always from `projectId` (linked targets own their target side; source-
  // only projects have none, LEFT JOIN handles that with NULL → "").
  const parts: string[] = [
    "SELECT",
    "  s.cell_id        AS cell_id,",
    "  s.file_id        AS file_id,",
    "  s.anchor_cell_id AS anchor_cell_id,",
    "  s.value          AS source_text,",
    "  s.event_id       AS source_event_id,",
    "  COALESCE(t.value, '')   AS target_text,",
    "  COALESCE(t.validated, 0) AS target_validated",
    "FROM cells s",
    "LEFT JOIN cells t",
    "  ON t.project_id = ?",  // bind: projectId (target side always local)
    " AND t.cell_id    = s.cell_id",
    " AND t.side       = 'target'",
    "WHERE s.project_id = COALESCE(?, ?)",  // bind: upstream, projectId
    "  AND s.side = 'source'",
  ]
  const binds: unknown[] = [args.projectId, upstreamProjectId, args.projectId]

  if (args.validatedOnly) {
    parts.push("AND t.validated = 1")
  }
  if (args.excludeCellId) {
    parts.push("AND s.cell_id != ?")
    binds.push(args.excludeCellId)
  }

  // Stable order for deterministic search results — by cell_id (UUIDv7
  // ordered lexicographically is timestamp-ordered).
  parts.push("ORDER BY s.cell_id")

  const sql = parts.join(" ")

  const res = await env.AQUILLA_DB.prepare(sql)
    .bind(...binds)
    .all<{
      cell_id: string
      file_id: string
      anchor_cell_id: string | null
      source_text: string
      source_event_id: string
      target_text: string
      target_validated: number
    }>()

  const cells: CorpusCell[] = []
  let maxEventId: string | null = null
  for (const row of res.results ?? []) {
    cells.push({
      cellId: row.cell_id,
      fileId: row.file_id,
      anchorCellId: row.anchor_cell_id,
      sourceEventId: row.source_event_id,
      sourceText: row.source_text,
      targetText: row.target_text,
      validated: row.target_validated === 1,
    })
    if (maxEventId === null || row.source_event_id > maxEventId) {
      maxEventId = row.source_event_id
    }
  }

  return {
    cells,
    upstreamProjectId,
    corpusEventMax: maxEventId,
  }
}
