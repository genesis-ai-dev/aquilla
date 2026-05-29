// AD-14 health-as-confidence read route (prototype).
//
//   GET /api/v1/projects/:projectId/cell-confidence?fileId=F[&cellIds=a,b][&topK=N][&perHopDecay=0.8][&maxHops=4]
//
// Health = how much human authority backs a cell, decaying with each hop away
// from a human-validated cell toward AI-inferred content:
//   - validated   → 100 (human-translated; ground truth).
//   - untranslated → skipped entirely (not "unhealthy", just not started).
//   - otherwise   → bounded multi-hop propagation: confidence ripples out from
//     validated cells through the example-retrieval graph (source-similar
//     neighbors), gated per edge by target consistency and decayed per hop.
//     A cell relying on low-health examples ends up low-health; one relying on
//     validated examples whose translation matches them ends up high.
//
// Derived on read from the always-current FTS index — nothing stored, so it
// self-heals against content/validation changes. PROTOTYPE: propagates over the
// whole file (one FTS MATCH per translated cell), capped at MAX_FILE_CELLS. At
// scale this would bound to the viewport + n-hop radius, or maintain an
// incremental k-NN graph. Auth: sync-token JWT scoped to `projectId`.

import { verifyTokenForProject } from "../auth"
import { makeVerifiedProjectId, querySourceNeighbors } from "./scoped-search"
import { lexicalConfidence } from "../lib/confidence/lexical-confidence"
import {
  propagateHealth,
  type PropNode,
  type PropEdges,
  type PropEdge,
} from "../lib/confidence/propagate-health"

export interface CellConfidenceEnv {
  AQUILLA_DB?: D1Database
  SYNC_SECRET_KEY?: string
}

const PATH_RE = /^\/api\/v1\/projects\/([^/]+)\/cell-confidence$/

const DEFAULT_TOP_K = 10
const MAX_TOP_K = 50
const DEFAULT_PER_HOP_DECAY = 0.8
const DEFAULT_MAX_HOPS = 4
const MAX_FILE_CELLS = 5000

interface FileCell {
  cellId: string
  sourceText: string
  targetText: string
  validated: boolean
}

interface CellConfidenceDetail {
  validated: boolean
  /** Number of example edges feeding this cell. */
  neighbors: number
  /** The neighbor that contributed most to this cell's health (observability). */
  topCellId: string | null
}

/** Load every source cell of a file with its target text + validated flag. */
async function loadFileCells(
  db: D1Database,
  projectId: string,
  fileId: string,
): Promise<FileCell[]> {
  const sql =
    "SELECT s.cell_id AS cell_id, s.value AS source_text, " +
    "COALESCE(t.value, '') AS target_text, COALESCE(t.validated, 0) AS validated " +
    "FROM cells s " +
    "LEFT JOIN cells t " +
    "  ON t.project_id = s.project_id AND t.file_id = s.file_id " +
    "  AND t.cell_id = s.cell_id AND t.side = 'target' " +
    "WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source' " +
    "LIMIT ?"
  const res = await db
    .prepare(sql)
    .bind(projectId, fileId, MAX_FILE_CELLS)
    .all<{ cell_id: string; source_text: string; target_text: string; validated: number }>()
  return (res.results ?? []).map((r) => ({
    cellId: r.cell_id,
    sourceText: r.source_text,
    targetText: r.target_text,
    validated: r.validated === 1,
  }))
}

export async function handleCellConfidenceRequest(
  request: Request,
  env: CellConfidenceEnv,
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
  if (!auth.ok) {
    return new Response(auth.reason, { status: auth.status })
  }
  const verifiedProjectId = makeVerifiedProjectId(auth.claims)

  const fileId = url.searchParams.get("fileId")
  if (!fileId) {
    return new Response("missing fileId", { status: 400 })
  }

  // Optional output filter — which cells to return. Absent → return all.
  const qCellIds = url.searchParams.get("cellIds")
  const wantCellIds = qCellIds
    ? new Set(qCellIds.split(",").map((s) => s.trim()).filter((s) => s.length > 0))
    : null

  let topK = DEFAULT_TOP_K
  const qTopK = url.searchParams.get("topK")
  if (qTopK !== null) {
    const parsed = parseInt(qTopK, 10)
    if (!isNaN(parsed)) topK = Math.min(MAX_TOP_K, Math.max(1, parsed))
  }
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

  // Nodes = translated cells (skip untranslated — not started, not unhealthy).
  const fileCells = await loadFileCells(env.AQUILLA_DB, projectId, fileId)
  const nodes: PropNode[] = []
  const nodeIds = new Set<string>()
  const byId = new Map<string, FileCell>()
  for (const c of fileCells) {
    if (c.targetText.trim() === "") continue
    nodes.push({ id: c.cellId, validated: c.validated })
    nodeIds.add(c.cellId)
    byId.set(c.cellId, c)
  }

  // Edges: for each unvalidated node, its top-k source-similar example cells
  // (validated or not — health flows from any neighbor). r = source similarity
  // (weights the mean), a = target consistency (gates the transfer).
  const edges: PropEdges = new Map()
  await Promise.all(
    nodes.map(async (node) => {
      if (node.validated) return // validated cells are anchors; no inbound need
      const cell = byId.get(node.id)!
      const neighbors = await querySourceNeighbors(
        env.AQUILLA_DB!,
        verifiedProjectId,
        cell.sourceText,
        { topK, excludeCellId: cell.cellId, validatedOnly: false },
      )
      const cellEdges: PropEdge[] = []
      for (const n of neighbors) {
        if (!nodeIds.has(n.cellId)) continue // keep the graph within the file
        const r = lexicalConfidence(cell.sourceText, [n.value])
        const a = lexicalConfidence(cell.targetText, [n.targetValue])
        cellEdges.push({ to: n.cellId, r, a })
      }
      if (cellEdges.length > 0) edges.set(node.id, cellEdges)
    }),
  )

  const health = propagateHealth(nodes, edges, { perHopDecay, maxHops })

  const confidence: Record<string, number> = {}
  const detail: Record<string, CellConfidenceDetail> = {}
  for (const node of nodes) {
    if (wantCellIds && !wantCellIds.has(node.id)) continue
    const h = health.get(node.id) ?? 0
    confidence[node.id] = h / 100
    // Observability: which neighbor contributed most to the final health.
    let topCellId: string | null = null
    if (!node.validated) {
      let best = -1
      for (const e of edges.get(node.id) ?? []) {
        const contrib = e.r * e.a * (health.get(e.to) ?? 0)
        if (contrib > best) {
          best = contrib
          topCellId = e.to
        }
      }
    }
    detail[node.id] = {
      validated: node.validated,
      neighbors: edges.get(node.id)?.length ?? 0,
      topCellId,
    }
  }

  return Response.json({
    confidence,
    detail,
    nodes: nodes.length,
    tookMs: Date.now() - startedAt,
  })
}
