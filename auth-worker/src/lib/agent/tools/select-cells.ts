// select-cells.ts — the shared work-list selector behind `read` and `draft`.
//
// This module IS the recipe the old prompt taught the model to hand-derive
// via SQL: fetch source/target pairs for a scope, put them in the file's true
// display order (sequence_index for timeline files, numeric chapter:verse for
// scripture, anchor-chain walk otherwise), classify each row's status, and
// scope by a human ref range ("MRK 4", "MRK 4:1-20"). Encoding it here means
// it is correct on every call instead of re-derived (or fumbled) per run.

export interface CellPair {
  cellId: string
  canonicalRef: string | null
  sequenceIndex: number | null
  anchorCellId: string | null
  source: string
  target: string
  validated: boolean
  aiDrafted: boolean
  /** cells.event_id of the source row (current source head). */
  sourceHead: string | null
  /** target row's source_event_id (what the last commit was based on). */
  targetBasedOn: string | null
  hasTargetRow: boolean
}

export type CellStatus = "untranslated" | "drafted" | "stale" | "validated" | "translated"

export function statusOf(pair: CellPair): CellStatus {
  if (!pair.target.trim()) return "untranslated"
  if (pair.validated) return "validated"
  if (pair.sourceHead && pair.targetBasedOn && pair.sourceHead !== pair.targetBasedOn) return "stale"
  if (pair.aiDrafted) return "drafted"
  return "translated"
}

// ── Ref-range grammar: "MRK", "MRK 4", "MRK 4:5", "MRK 4:1-20" ─────────────

export interface RefRange {
  book: string
  chapter?: number
  verseFrom?: number
  verseTo?: number
}

export function parseRefRange(ref: string): RefRange | null {
  const m = ref
    .trim()
    .toUpperCase()
    .match(/^([1-3]?[A-Z]{2,4})(?:\s+(\d+)(?::(\d+)(?:\s*[-–]\s*(\d+))?)?)?$/)
  if (!m) return null
  const range: RefRange = { book: m[1] }
  if (m[2]) range.chapter = Number(m[2])
  if (m[3]) {
    range.verseFrom = Number(m[3])
    range.verseTo = m[4] ? Number(m[4]) : Number(m[3])
  }
  return range
}

/** Parse a canonical_ref like "MRK 4:12" (or "MRK 4") into sortable parts. */
function parseCanonical(ref: string | null): { book: string; chapter: number; verse: number } | null {
  if (!ref) return null
  const m = ref.trim().toUpperCase().match(/^([1-3]?[A-Z]{2,4})\s+(\d+)(?::(\d+))?/)
  if (!m) return null
  return { book: m[1], chapter: Number(m[2]), verse: m[3] ? Number(m[3]) : 0 }
}

function inRange(ref: string | null, range: RefRange): boolean {
  const c = parseCanonical(ref)
  if (!c) return false
  if (c.book !== range.book) return false
  if (range.chapter === undefined) return true
  if (c.chapter !== range.chapter) return false
  if (range.verseFrom === undefined) return true
  return c.verse >= range.verseFrom && c.verse <= (range.verseTo ?? range.verseFrom)
}

// ── Ordering ────────────────────────────────────────────────────────────────

function compareCanonical(a: CellPair, b: CellPair): number {
  const ca = parseCanonical(a.canonicalRef)
  const cb = parseCanonical(b.canonicalRef)
  if (!ca || !cb) return 0
  if (ca.book !== cb.book) return ca.book < cb.book ? -1 : 1
  return ca.chapter - cb.chapter || ca.verse - cb.verse
}

/** Walk the anchor chain (anchor_cell_id → previous cell; null = first). */
function anchorChainOrder(pairs: CellPair[]): CellPair[] {
  const byAnchor = new Map<string | null, CellPair[]>()
  for (const p of pairs) {
    const list = byAnchor.get(p.anchorCellId) ?? []
    list.push(p)
    byAnchor.set(p.anchorCellId, list)
  }
  const out: CellPair[] = []
  const seen = new Set<string>()
  let frontier = byAnchor.get(null) ?? []
  while (frontier.length > 0 && out.length < pairs.length) {
    const next: CellPair[] = []
    for (const p of frontier) {
      if (seen.has(p.cellId)) continue
      seen.add(p.cellId)
      out.push(p)
      next.push(...(byAnchor.get(p.cellId) ?? []))
    }
    frontier = next
  }
  // Orphans (broken chains) keep their fetch order at the end.
  for (const p of pairs) if (!seen.has(p.cellId)) out.push(p)
  return out
}

/** Sort pairs into the file's display order. */
export function orderPairs(pairs: CellPair[]): CellPair[] {
  if (pairs.some((p) => p.sequenceIndex !== null)) {
    return [...pairs].sort(
      (a, b) => (a.sequenceIndex ?? Number.MAX_SAFE_INTEGER) - (b.sequenceIndex ?? Number.MAX_SAFE_INTEGER),
    )
  }
  if (pairs.some((p) => parseCanonical(p.canonicalRef))) {
    return [...pairs].sort(compareCanonical)
  }
  return anchorChainOrder(pairs)
}

// ── Selection ───────────────────────────────────────────────────────────────

export interface SelectScope {
  fileId?: string
  range?: RefRange
}

interface PairRow {
  cell_id: string
  canonical_ref: string | null
  sequence_index: number | string | null
  anchor_cell_id: string | null
  source_value: string
  target_value: string | null
  validated: number | null
  ai_drafted: number | null
  source_head: string | null
  target_based_on: string | null
  has_target: number | null
}

/**
 * Resolve a scope with no fileId by the range's book code. `files.book_code`
 * is authoritative when set, but the current import pipeline never populates
 * it, so fall back to (a) a file NAMED like the book ("MRK", "MRK.usfm",
 * "Mark of MRK"), then (b) the file whose cells actually carry "MRK …"
 * canonical refs — that one always works for imported scripture.
 */
export async function resolveFileByBook(
  db: AquillaDb,
  projectId: string,
  book: string,
): Promise<{ id: string; name: string } | null> {
  const code = book.toUpperCase()
  const byCode = await db
    .prepare(
      `SELECT id, name FROM files
       WHERE project_id = ? AND deleted_at IS NULL AND upper(book_code) = ?
       ORDER BY role = 'target' DESC LIMIT 1`,
    )
    .bind(projectId, code)
    .first<{ id: string; name: string }>()
  if (byCode) return byCode
  const byName = await db
    .prepare(
      `SELECT id, name FROM files
       WHERE project_id = ? AND deleted_at IS NULL
         AND (upper(name) = ? OR upper(name) LIKE ? OR upper(name) LIKE ?)
       ORDER BY length(name) ASC LIMIT 1`,
    )
    .bind(projectId, code, `${code}.%`, `%${code}%`)
    .first<{ id: string; name: string }>()
  if (byName) return byName
  const byRefs = await db
    .prepare(
      `SELECT f.id, f.name FROM files f
       WHERE f.project_id = ? AND f.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM cells c
           WHERE c.project_id = f.project_id AND c.file_id = f.id
             AND c.side = 'source'
             AND upper(c.canonical_ref) LIKE ?
         )
       LIMIT 1`,
    )
    .bind(projectId, `${code} %`)
    .first<{ id: string; name: string }>()
  return byRefs ?? null
}

/**
 * Fetch source/target pairs for a file (optionally ref-scoped), in display
 * order. The caller applies status filters/limits — this returns the file.
 */
export async function selectCellPairs(
  db: AquillaDb,
  projectId: string,
  scope: { fileId: string; range?: RefRange; targetLang?: string },
): Promise<CellPair[]> {
  const lanePredicate = scope.targetLang === undefined ? "" : " AND t.target_lang = ?"
  const { results } = await db
    .prepare(
      `SELECT s.cell_id, s.canonical_ref, s.sequence_index, s.anchor_cell_id,
              s.value AS source_value, t.value AS target_value,
              t.validated, t.ai_drafted,
              s.event_id AS source_head, t.source_event_id AS target_based_on,
              CASE WHEN t.cell_id IS NULL THEN 0 ELSE 1 END AS has_target
       FROM cells s
       LEFT JOIN cells t
         ON t.project_id = s.project_id AND t.file_id = s.file_id
        AND t.cell_id = s.cell_id AND t.side = 'target'${lanePredicate}
       WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source'
         AND s.target_lang = ''`,
    )
    .bind(...(scope.targetLang === undefined
      ? [projectId, scope.fileId]
      : [scope.targetLang, projectId, scope.fileId]))
    .all<PairRow>()

  let pairs: CellPair[] = results.map((r) => ({
    cellId: r.cell_id,
    canonicalRef: r.canonical_ref,
    sequenceIndex: r.sequence_index === null ? null : Number(r.sequence_index),
    anchorCellId: r.anchor_cell_id,
    source: r.source_value ?? "",
    target: r.target_value ?? "",
    validated: Number(r.validated ?? 0) === 1,
    aiDrafted: Number(r.ai_drafted ?? 0) === 1,
    sourceHead: r.source_head,
    targetBasedOn: r.target_based_on,
    hasTargetRow: Number(r.has_target ?? 0) === 1,
  }))

  if (scope.range) pairs = pairs.filter((p) => inRange(p.canonicalRef, scope.range!))
  return orderPairs(pairs)
}
