// AD-14 amendment 2026-06-04 — health rollup pull route.
//
//   GET /api/v1/projects/:projectId/health-rollup[?fileId=F][&maxHops=4][&perHopDecay=0.8]
//
// Returns aggregate confidence-derived health (0-100) for a project (and
// optionally a single file). This is `mean(confidence over translated cells in
// scope)` — untranslated cells are excluded (not started, not unhealthy).
//
// Derivation uses the same multi-hop propagation as cell-confidence-route.ts:
//   confidence(validated) = 100
//   confidence(X)         = perHopDecay × Σ(r·a·conf(Y)) / Σ(r)  over top-k neighbors
//
// The materialized cell_edges graph (from the design doc) is a future
// optimisation — this route runs the FTS-based propagation on demand.
// At Bible scale (~31k cells) this is an expensive read; we deliberately ship
// the pull model first and promote to a DO broadcast + materialized graph only
// when latency data justifies it. See SWARM-TODO below.
//
// SWARM-TODO (AQU-190 / next wave): wire health.rollup DO broadcast so clients
// receive a pushed update after cell.validate without re-fetching.
//
// Auth: sync-token JWT scoped to projectId.

import { verifyTokenForProject } from "../auth"
import { visibleLanesForRead } from "./lane-read-wall"
import { makeVerifiedProjectId, queryFileSourceNeighbors } from "./scoped-search"
import { lexicalConfidence } from "../lib/confidence/lexical-confidence"
import { propagateHealth, type PropNode, type PropEdges, type PropEdge } from "../lib/confidence/propagate-health"

export interface HealthRollupEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
  /** AQU-730. Unset locally and in e2e. */
  LANE_READ_WALL?: string
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/health-rollup$/

const DEFAULT_PER_HOP_DECAY = 0.8
const DEFAULT_MAX_HOPS = 4
const DEFAULT_TOP_K = 10
// Cap file cell count to bound the FTS N+1 cost.
const MAX_FILE_CELLS = 5000
// Cap number of files processed in a project-wide rollup.
const MAX_FILES = 200

export interface HealthRollupResponse {
  /** Overall project health 0-100 = mean(confidence over translated cells). */
  projectHealth: number
  /** fileId → file health 0-100. Present when no fileId filter given. */
  fileHealth: Record<string, number>
  /** Total translated cells included in the rollup. */
  totalCells: number
  tookMs: number
}

interface FileRow {
  file_id: string
}

interface CellRow {
  cell_id: string
  source_text: string
  target_text: string
  validated: number
}

async function loadProjectFiles(db: AquillaDb, projectId: string): Promise<string[]> {
  const res = await db
    .prepare("SELECT DISTINCT file_id FROM cells WHERE project_id = ? AND side = 'source' LIMIT ?")
    .bind(projectId, MAX_FILES)
    .all<FileRow>()
  return (res.results ?? []).map((r) => r.file_id)
}

async function loadFileCellsForRollup(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  targetLang: string,
): Promise<CellRow[]> {
  // One target lane. Joining every target row duplicated a verse that had
  // two translations and let a hidden lane change the score.
  const sql =
    "SELECT s.cell_id AS cell_id, s.value AS source_text, " +
    "COALESCE(t.value, '') AS target_text, COALESCE(t.validated, 0) AS validated " +
    "FROM cells s " +
    "LEFT JOIN cells t " +
    "  ON t.project_id = s.project_id AND t.file_id = s.file_id " +
    "  AND t.cell_id = s.cell_id AND t.side = 'target' AND t.target_lang = ? " +
    "WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source' " +
    "LIMIT ?"
  const res = await db
    .prepare(sql)
    .bind(targetLang, projectId, fileId, MAX_FILE_CELLS)
    .all<CellRow>()
  return res.results ?? []
}

/**
 * Compute mean confidence (0-100) for a single file by running the multi-hop
 * propagation over FTS-retrieved neighbors.
 */
async function computeFileHealth(
  db: AquillaDb,
  verifiedProjectId: string & { __brand: "verified-project-id" },
  fileId: string,
  opts: { perHopDecay: number; maxHops: number; topK: number; targetLang: string },
): Promise<{ health: number; cellCount: number }> {
  const rawCells = await loadFileCellsForRollup(db, verifiedProjectId, fileId, opts.targetLang)

  // Only translated cells participate (untranslated = not started, not unhealthy).
  const cells = rawCells.filter((c) => c.target_text.trim() !== "")
  if (cells.length === 0) return { health: 0, cellCount: 0 }

  const nodes: PropNode[] = cells.map((c) => ({ id: c.cell_id, validated: c.validated === 1 }))
  const nodeIds = new Set(nodes.map((n) => n.id))
  const byId = new Map(cells.map((c) => [c.cell_id, c]))

  // Build edges: for each unvalidated node, its top-k source-similar neighbors.
  // AQU-1005: retrieval is file+lane-scoped in ONE statement — this route only
  // ever keeps same-file neighbors, so the old project-wide LATERAL sweep was
  // pure wasted compute (minutes per call on large projects).
  const unvalidated = nodes.filter((n) => !n.validated)
  const neighborMap =
    unvalidated.length === 0
      ? new Map<string, never[]>()
      : await queryFileSourceNeighbors(db, verifiedProjectId, fileId, {
          topK: opts.topK,
          targetLang: opts.targetLang,
        })
  const edges: PropEdges = new Map()
  for (const node of unvalidated) {
    const cell = byId.get(node.id)!
    const cellEdges: PropEdge[] = []
    for (const n of neighborMap.get(node.id) ?? []) {
      if (!nodeIds.has(n.cellId)) continue
      const r = lexicalConfidence(cell.source_text, [n.value])
      const a = lexicalConfidence(cell.target_text, [n.targetValue])
      cellEdges.push({ to: n.cellId, r, a })
    }
    if (cellEdges.length > 0) edges.set(node.id, cellEdges)
  }

  const health = propagateHealth(nodes, edges, { perHopDecay: opts.perHopDecay, maxHops: opts.maxHops })

  let sum = 0
  for (const node of nodes) {
    sum += health.get(node.id) ?? 0
  }
  return { health: Math.round(sum / nodes.length), cellCount: nodes.length }
}

/**
 * Lanes whose translations may enter the score.
 * Wall off, Maintainer, and platform: the requested lane, or `''` when the
 * card does not name one. Below Maintainer with the wall on: granted legacy
 * tags only. A requested tag outside that set scores as no cells.
 */
async function laneTagsToScore(
  env: HealthRollupEnv,
  projectId: string,
  claims: Parameters<typeof visibleLanesForRead>[1],
  requestedLane: string | null,
): Promise<string[]> {
  const visible = visibleLanesForRead(env.LANE_READ_WALL, claims)
  if (visible === null) return [requestedLane ?? ""]
  if (!env.AQUILLA_PG || visible.size === 0) return []
  const { results } = await env.AQUILLA_PG.prepare(
    `SELECT id, legacy_tag FROM lanes WHERE project_id = ? AND role = 'target'`,
  )
    .bind(projectId)
    .all<{ id: string; legacy_tag: string | null }>()
  const tags = new Set<string>()
  for (const row of results ?? []) {
    if (!visible.has(row.id)) continue
    tags.add(row.legacy_tag ?? "")
  }
  if (requestedLane !== null) return tags.has(requestedLane) ? [requestedLane] : []
  return [...tags]
}

export async function handleHealthRollupRequest(
  request: Request,
  env: HealthRollupEnv,
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
  const verifiedProjectId = makeVerifiedProjectId(auth.claims)

  const filterFileId = url.searchParams.get("fileId") ?? null

  let perHopDecay = DEFAULT_PER_HOP_DECAY
  const qDecay = url.searchParams.get("perHopDecay")
  if (qDecay !== null) {
    const parsed = parseFloat(qDecay)
    if (!isNaN(parsed)) perHopDecay = Math.min(1, Math.max(0.01, parsed))
  }

  let maxHops = DEFAULT_MAX_HOPS
  const qHops = url.searchParams.get("maxHops")
  if (qHops !== null) {
    const parsed = parseInt(qHops, 10)
    if (!isNaN(parsed)) maxHops = Math.min(20, Math.max(1, parsed))
  }

  const startedAt = Date.now()
  // Optional target-language lane ('' = the single-lane default). Scopes
  // neighbor retrieval so multi-lane projects don't mix languages (AQU-1005).
  // The cell load uses the same lane. The project card omits `lane`, so a
  // restricted caller is scored once per granted lane and the ring is the
  // weighted mean of those scores. A requested lane they were not granted
  // contributes nothing.
  const requestedLane = url.searchParams.get("lane")
  const laneTags = await laneTagsToScore(env, projectId, auth.claims, requestedLane)
  const propagation = { perHopDecay, maxHops, topK: DEFAULT_TOP_K }

  const fileHealth: Record<string, number> = {}
  let totalCells = 0
  let projectHealthSum = 0

  const scoreFile = async (fileId: string) => {
    let weighted = 0
    let cells = 0
    for (const tag of laneTags) {
      const result = await computeFileHealth(env.AQUILLA_PG!, verifiedProjectId, fileId, {
        ...propagation,
        targetLang: tag,
      })
      weighted += result.health * result.cellCount
      cells += result.cellCount
    }
    return { health: cells > 0 ? Math.round(weighted / cells) : 0, cellCount: cells }
  }

  if (filterFileId) {
    const { health, cellCount } = await scoreFile(filterFileId)
    fileHealth[filterFileId] = health
    totalCells = cellCount
    projectHealthSum = health * cellCount
  } else {
    const fileIds = await loadProjectFiles(env.AQUILLA_PG, verifiedProjectId)
    await Promise.all(
      fileIds.map(async (fileId) => {
        const { health, cellCount } = await scoreFile(fileId)
        fileHealth[fileId] = health
        totalCells += cellCount
        projectHealthSum += health * cellCount
      }),
    )
  }

  const projectHealth = totalCells > 0 ? Math.round(projectHealthSum / totalCells) : 0

  const body: HealthRollupResponse = {
    projectHealth,
    fileHealth,
    totalCells,
    tookMs: Date.now() - startedAt,
  }

  return Response.json(body)
}
