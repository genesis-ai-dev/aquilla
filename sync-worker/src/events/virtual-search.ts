// AQU-2459 Phase B: Manifest-backed search over virtual source files.
//
// Virtual source files (`files.source_virtual = TRUE`) have ZERO `side = 'source'`
// rows in Postgres `cells`. `scoped-search.ts` finds every materialized file's
// cells AND every target cell on virtual files; this module searches the
// virtual files' source units (from isolate-cached R2 manifests) using the
// exact same `db/shared/find-pattern.ts` matcher and merges them cleanly with
// the Postgres page.

import type { AquillaDb } from '../../../db/shim/postgres'
import {
  findTextMatches,
  markedSnippetOfAll,
  type TextFindOptions,
} from '../../../db/shared/find-pattern'
import {
  loadProjectVirtualSourceFiles,
  type ManifestR2Bucket,
  type VirtualSourceRow,
} from '../../../db/shared/virtual-source-store'
import { targetVisibilityClause } from './lane-read-wall'
import type { ParallelPassageRow, SearchPage, SearchResultOut } from './scoped-search'

function placeLabelOf(row: VirtualSourceRow): string | null {
  const m = row.metadata
  if (!m) return null
  const aq = m.aquillaImport as Record<string, unknown> | undefined
  const ms = aq?.milestone as Record<string, unknown> | undefined
  const candidates = [ms?.label, m.cellLabel, m.cast_name, aq?.displayLabel]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c.trim()
  }
  return null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchVirtualText(
  text: string,
  query: string,
  mode: 'fts' | 'pattern' | 'exact',
  opts: { matchCase?: boolean; wholeWord?: boolean; useRegexp?: boolean },
): { matched: boolean; score: number; snippet: string } {
  if (!text) return { matched: false, score: 0, snippet: '' }
  if (mode === 'exact') {
    const idx = text.toLowerCase().indexOf(query.trim().toLowerCase())
    if (idx < 0) return { matched: false, score: 0, snippet: '' }
    const m = findTextMatches(text, query.trim(), { matchCase: false, wholeWord: false, useRegexp: false })
    return { matched: true, score: m.length || 1, snippet: m.length > 0 ? markedSnippetOfAll(text, m) : text }
  }
  if (mode === 'pattern') {
    const findOpts: TextFindOptions = {
      matchCase: opts.matchCase === true,
      wholeWord: opts.wholeWord === true,
      useRegexp: opts.useRegexp === true,
    }
    const matches = findTextMatches(text, query, findOpts)
    if (matches.length === 0) return { matched: false, score: 0, snippet: '' }
    return { matched: true, score: matches.length, snippet: markedSnippetOfAll(text, matches) }
  }
  // FTS-like multi-token match: every whitespace-separated term must appear
  // case-insensitively in `text`.
  const terms = query
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/^["']+|["']+$/g, ''))
    .filter(Boolean)
  if (terms.length === 0) return { matched: false, score: 0, snippet: '' }
  const lower = text.toLowerCase()
  for (const term of terms) {
    if (!lower.includes(term.toLowerCase())) return { matched: false, score: 0, snippet: '' }
  }
  const combinedRe = new RegExp(terms.map(escapeRegExp).join('|'), 'gi')
  const matches: Array<{ index: number; text: string; groups: string[] }> = []
  let m: RegExpExecArray | null
  while ((m = combinedRe.exec(text)) !== null) {
    if (m[0].length === 0) {
      combinedRe.lastIndex++
      continue
    }
    matches.push({ index: m.index, text: m[0], groups: [] })
    if (matches.length >= 64) break
  }
  return {
    matched: true,
    score: matches.length || 1,
    snippet: matches.length > 0 ? markedSnippetOfAll(text, matches) : text,
  }
}

export async function mergeVirtualSourceSearchPage<Row extends SearchResultOut>(
  db: AquillaDb,
  r2: ManifestR2Bucket | undefined,
  projectId: string,
  pgPage: SearchPage<Row>,
  args: {
    q: string
    mode: 'fts' | 'pattern' | 'exact'
    side?: 'source' | 'target'
    fileId?: string
    limit: number
    laneIds: readonly string[] | null
    matchCase?: boolean
    wholeWord?: boolean
    useRegexp?: boolean
  },
): Promise<SearchPage<Row>> {
  if (!r2) return pgPage

  // Load virtual files in scope (exclude soft-deleted & uncounted files).
  const virtualFiles = await loadProjectVirtualSourceFiles(db, r2, projectId, {
    ...(args.fileId ? { fileIds: [args.fileId] } : {}),
  })
  if (virtualFiles.length === 0) return pgPage

  const virtualByFile = new Map(virtualFiles.map((vf) => [vf.head.fileId, vf]))

  // 1. Hydrate missing source metadata (`pairedValue`, `canonicalRef`, `cellType`,
  //    `placeLabel`, `position`) on Postgres TARGET hits belonging to virtual files!
  const hydratedPgResults = pgPage.results.map((hit) => {
    if (hit.side !== 'target') return hit
    const vf = virtualByFile.get(hit.fileId)
    if (!vf) return hit
    const src = vf.byCellId.get(hit.cellId)
    if (!src) return hit
    const visiblePos =
      hit.position ??
      (() => {
        let pos = 0
        for (const r of vf.rows) {
          if (r.hidden_at != null || r.tombstoned_at != null) continue
          pos++
          if (r.cell_id === hit.cellId) return pos
        }
        return null
      })()
    return {
      ...hit,
      pairedValue: hit.pairedValue ?? src.value,
      canonicalRef: hit.canonicalRef ?? src.canonical_ref,
      cellType: hit.cellType ?? src.type,
      placeLabel: hit.placeLabel ?? placeLabelOf(src),
      position: visiblePos,
    }
  })

  if (args.side === 'target') {
    return { ...pgPage, results: hydratedPgResults }
  }

  // 2. Search virtual source units (skipping any cellId that already returned as
  //    a sparse Postgres source overlay hit).
  const existingSourceKeys = new Set(
    hydratedPgResults
      .filter((r) => r.side === 'source')
      .map((r) => `${r.fileId}\0${r.cellId}`),
  )

  const virtualHits: Array<{
    fileId: string
    cellId: string
    value: string
    snippet: string
    rank: number
    canonicalRef: string | null
    cellType: string | null
    placeLabel: string | null
    position: number
  }> = []

  for (const vf of virtualFiles) {
    let pos = 0
    for (const row of vf.rows) {
      if (row.hidden_at != null || row.tombstoned_at != null) continue
      pos++
      if (existingSourceKeys.has(`${row.file_id}\0${row.cell_id}`)) continue
      const m = matchVirtualText(row.value, args.q, args.mode, args)
      if (!m.matched) continue
      virtualHits.push({
        fileId: row.file_id,
        cellId: row.cell_id,
        value: row.value,
        snippet: m.snippet,
        rank: m.score,
        canonicalRef: row.canonical_ref,
        cellType: row.type,
        placeLabel: placeLabelOf(row),
        position: pos,
      })
    }
  }

  if (virtualHits.length === 0) {
    return { ...pgPage, results: hydratedPgResults }
  }

  // Hydrate `pairedValue` (target text) only for the top virtual hits that can
  // make it into the returned page.
  virtualHits.sort((a, b) => b.rank - a.rank)
  const topVirtual = virtualHits.slice(0, args.limit)
  const targetValues = new Map<string, string>()
  if (topVirtual.length > 0) {
    const tuples = topVirtual.map((h) => [h.fileId, h.cellId] as const)
    const ph = tuples.map(() => '(?, ?)').join(', ')
    const tParts = [
      `SELECT file_id, cell_id, value FROM cells WHERE project_id = ? AND side = 'target' AND (file_id, cell_id) IN (${ph})`,
    ]
    const tBinds: unknown[] = [projectId, ...tuples.flat()]
    const wall = targetVisibilityClause({
      laneIds: args.laneIds,
      sideExpr: 'side',
      laneIdExpr: 'lane_id',
    })
    if (wall) {
      tParts.push(wall.sql)
      tBinds.push(...wall.binds)
    }
    const tRes = await db
      .prepare(tParts.join(' '))
      .bind(...tBinds)
      .all<{ file_id: string; cell_id: string; value: string }>()
    for (const r of tRes.results ?? []) {
      const k = `${r.file_id}\0${r.cell_id}`
      if (!targetValues.has(k)) targetValues.set(k, r.value)
    }
  }

  const mappedVirtual: ParallelPassageRow[] = topVirtual.map((h) => ({
    cellId: h.cellId,
    fileId: h.fileId,
    side: 'source',
    value: h.value,
    snippet: h.snippet,
    rank: h.rank,
    pairedValue: targetValues.get(`${h.fileId}\0${h.cellId}`) ?? null,
    canonicalRef: h.canonicalRef,
    cellType: h.cellType,
    placeLabel: h.placeLabel,
    position: h.position,
  }))

  const combined = [...hydratedPgResults, ...(mappedVirtual as unknown as Row[])]
    .sort((a, b) => b.rank - a.rank)
    .slice(0, args.limit)

  return {
    results: combined,
    total: pgPage.total + virtualHits.length,
    totalIsLowerBound: pgPage.totalIsLowerBound,
  }
}
