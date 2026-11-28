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

import { targetLaneDualReadBinds, targetLaneDualReadSql } from "../../events/lane-id-sql"
import { loadProjectVirtualSourceFiles } from "../../../../db/shared/virtual-source-store"
import type { CorpusCell } from "./algorithm"

export interface CorpusLoaderEnv {
  AQUILLA_PG?: AquillaDb
  /** AQU-2459 Phase B: R2 bucket holding revision manifests for virtual source files. */
  SNAPSHOTS?: R2Bucket
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
  if (!env.AQUILLA_PG) return null
  try {
    const row = await env.AQUILLA_PG.prepare(
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
  /** Lane tag stored on `cells.target_lang`. Default lane is `""` (omitted
   *  param treated the same so old clients stay single-lane). Extra-lane
   *  tags (`French`, `es`, …) are the tag itself — not the Settings display
   *  name. AQU-1025: without this bind a cell contributes every target lane. */
  targetLang?: string
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
 * three project-shape behaviors. Throws on Postgres errors; the route handler
 * surfaces them as 500. (Unlike `stale-source-route` which soft-fails to
 * empty, the corpus is fundamental to this endpoint — a missing one is
 * an error, not "no neighbors.")
 */
export async function loadCorpus(
  env: CorpusLoaderEnv,
  args: LoadCorpusArgs,
): Promise<LoadCorpusResult> {
  if (!env.AQUILLA_PG) {
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
    ` AND ${targetLaneDualReadSql("t")}`,  // binds: projectId, tag, tag ('' = default lane)
    "WHERE s.project_id = COALESCE(?, ?)",  // bind: upstream, projectId
    "  AND s.side = 'source'",
  ]
  const binds: unknown[] = [
    args.projectId,
    ...targetLaneDualReadBinds(args.projectId, args.targetLang ?? ""),
    upstreamProjectId,
    args.projectId,
  ]

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

  const res = await env.AQUILLA_PG.prepare(sql)
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
  const seenKeys = new Set<string>()
  let maxEventId: string | null = null
  for (const row of res.results ?? []) {
    seenKeys.add(`${row.file_id}\0${row.cell_id}`)
    cells.push({
      cellId: row.cell_id,
      fileId: row.file_id,
      anchorCellId: row.anchor_cell_id,
      sourceText: row.source_text,
      targetText: row.target_text,
      validated: row.target_validated === 1,
    })
    if (maxEventId === null || row.source_event_id > maxEventId) {
      maxEventId = row.source_event_id
    }
  }

  // AQU-2459 Phase B: include virtual source files from the effective source project.
  if (env.SNAPSHOTS) {
    const effectiveSourceProjectId = upstreamProjectId ?? args.projectId
    const vFiles = await loadProjectVirtualSourceFiles(
      env.AQUILLA_PG,
      env.SNAPSHOTS,
      effectiveSourceProjectId,
    )
    if (vFiles.length > 0) {
      const vFileIds = vFiles.map((vf) => vf.head.fileId)
      const ph = vFileIds.map(() => "?").join(", ")
      const tRes = await env.AQUILLA_PG.prepare(
        `SELECT file_id, cell_id, COALESCE(value, '') AS value, COALESCE(validated, 0) AS validated
           FROM cells
          WHERE project_id = ? AND side = 'target'
            AND ${targetLaneDualReadSql("cells")}
            AND file_id IN (${ph})`,
      )
        .bind(
          args.projectId,
          ...targetLaneDualReadBinds(args.projectId, args.targetLang ?? ""),
          ...vFileIds,
        )
        .all<{ file_id: string; cell_id: string; value: string; validated: number }>()
      const tByCell = new Map<string, { value: string; validated: number }>()
      for (const t of tRes.results ?? []) {
        tByCell.set(`${t.file_id}\0${t.cell_id}`, { value: t.value, validated: Number(t.validated) })
        // Linked-target projects may pair across files by cell_id.
        if (!tByCell.has(`\0${t.cell_id}`)) {
          tByCell.set(`\0${t.cell_id}`, { value: t.value, validated: Number(t.validated) })
        }
      }
      for (const vf of vFiles) {
        if (maxEventId === null || vf.head.revisionEventId > maxEventId) {
          maxEventId = vf.head.revisionEventId
        }
        for (const s of vf.rows) {
          if (args.excludeCellId && s.cell_id === args.excludeCellId) continue
          const k = `${vf.head.fileId}\0${s.cell_id}`
          if (seenKeys.has(k)) continue
          const t = tByCell.get(k) ?? (upstreamProjectId ? tByCell.get(`\0${s.cell_id}`) : undefined)
          const validated = (t?.validated ?? 0) === 1
          if (args.validatedOnly && !validated) continue
          seenKeys.add(k)
          cells.push({
            cellId: s.cell_id,
            fileId: vf.head.fileId,
            anchorCellId: s.anchor_cell_id,
            sourceText: s.value,
            targetText: t?.value ?? "",
            validated,
          })
          if (maxEventId === null || s.event_id > maxEventId) {
            maxEventId = s.event_id
          }
        }
      }
      cells.sort((a, b) => a.cellId.localeCompare(b.cellId))
    }
  }

  return {
    cells,
    upstreamProjectId,
    corpusEventMax: maxEventId,
  }
}
