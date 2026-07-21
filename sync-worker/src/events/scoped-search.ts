// Scoped search helpers — Step 5 of the v3 search permission model.
//
// This module is the SINGLE choke-point for all FTS5 cell-search queries.
// Every search surface MUST route through `queryScopedSearch` or
// `queryScopedExact` — both accept a `VerifiedProjectId` rather than a raw
// string, so passing an un-verified projectId is a TypeScript compile error.
//
// The permission boundary is structural, not advisory:
//   - `VerifiedProjectId` is a branded type that only `makeVerifiedProjectId`
//     can produce.
//   - `makeVerifiedProjectId` only accepts a `SyncTokenClaims` object — which
//     can only be obtained after JWT verification passes in auth.ts.
//   - The `AND cells.project_id = ?` predicate is hardcoded here, not supplied
//     by the caller, so it cannot be accidentally omitted.

import type { SyncTokenClaims } from "../auth"

// ---------------------------------------------------------------------------
// Branded type — the permission gate
// ---------------------------------------------------------------------------

/**
 * A projectId that has been verified against a decoded JWT claim. The brand
 * prevents any raw `string` from being passed where a scoped-query expects
 * a verified origin.
 *
 * Construction: only via `makeVerifiedProjectId(claims)` — never via a cast
 * at the call site.
 */
export type VerifiedProjectId = string & { __brand: "verified-project-id" }

/**
 * Produce a `VerifiedProjectId` from verified JWT claims. The caller is
 * responsible for obtaining `claims` via `verifyTokenForProject` (or similar)
 * before calling this. The type system enforces that `SyncTokenClaims` must
 * be satisfied — a raw `{ projectId: "abc" }` literal won't compile here
 * because it lacks the other required fields.
 */
export function makeVerifiedProjectId(claims: SyncTokenClaims): VerifiedProjectId {
  return claims.projectId as VerifiedProjectId
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface SearchResultOut {
  cellId: string
  fileId: string
  side: "source" | "target"
  value: string
  /** FTS5 snippet with `<mark>...</mark>` highlights around matched terms. */
  snippet: string
  rank: number
}

export interface ParallelPassageRow extends SearchResultOut {
  /**
   * The opposite-side cell value at the same (file_id, cell_id), if it
   * exists. null when there is no paired cell (e.g. orphaned source row, or
   * the project hasn't translated that cell yet).
   */
  pairedValue: string | null
}

// ---------------------------------------------------------------------------
// Raw DB row shapes (internal only)
// ---------------------------------------------------------------------------

interface SearchRowRaw {
  cell_id: string
  file_id: string
  side: "source" | "target"
  value: string
  snippet: string
  rank: number
}

interface ExactRowRaw extends SearchRowRaw {
  paired_value: string | null
}

// ---------------------------------------------------------------------------
// Sanitizers — exported so search-route.ts can import them (Step 6 will
// remove the duplicate in search-route.ts; for now both coexist).
// ---------------------------------------------------------------------------

/**
 * Sanitize a free-text query for FTS5 MATCH. FTS5's parser blows up on
 * unbalanced parens, bare colons, double quotes mid-token, and the reserved
 * keywords AND/OR/NOT/NEAR. We strip those out and wrap the survivors in
 * double quotes to force phrase matching, which is the closest UX to
 * "what the translator typed".
 *
 * Returns null when the resulting query is empty (e.g. the user typed only
 * punctuation). Callers should treat null as "no results".
 */
export function sanitizeFtsQuery(raw: string): string | null {
  // Drop FTS5 syntax punctuation: quotes, parens, colons, asterisks, pluses,
  // minuses. Keep letters, digits, whitespace, and dashes-internal-to-words
  // (we collapse runs of non-word into a single space below).
  const cleaned = raw.replace(/["()*:+-]/g, " ")
  // Split into bare tokens; reject the FTS reserved keywords case-insensitively
  // by lowercasing the comparison.
  const RESERVED = new Set(["and", "or", "not", "near"])
  const tokens = cleaned
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .filter((t) => !RESERVED.has(t.toLowerCase()))
  if (tokens.length === 0) return null
  // Wrap each token in double quotes — FTS5 treats `"foo"` as a single-token
  // phrase, sidestepping any remaining parse ambiguity.
  return tokens.map((t) => `"${t}"`).join(" ")
}

/**
 * Sanitize a phrase for FTS5 adjacent-phrase (ordered) matching. Like
 * `sanitizeFtsQuery` in cleanup, but wraps the whole token sequence in a
 * single pair of double quotes so FTS5 treats them as a contiguous phrase —
 * `"token1 token2 token3"` matches cells where those tokens appear in that
 * exact order with no gaps.
 *
 * Differs from `sanitizeFtsQuery` (which emits `"t1" "t2"` — all tokens
 * present, any order) — this is the right choice when the caller wants
 * "find cells containing this exact phrase".
 *
 * Returns null for empty / all-reserved input; callers should treat null as
 * "no results".
 */
export function sanitizeFtsExactPhrase(raw: string): string | null {
  const cleaned = raw.replace(/["()*:+-]/g, " ")
  const RESERVED = new Set(["and", "or", "not", "near"])
  const tokens = cleaned
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .filter((t) => !RESERVED.has(t.toLowerCase()))
  if (tokens.length === 0) return null
  // Single quoted phrase — FTS5 matches the exact token sequence in order.
  return '"' + tokens.join(" ") + '"'
}

/**
 * Sanitize free text into an FTS5 *any-term* (OR) query: `"t1" OR "t2" ...`.
 *
 * Unlike `sanitizeFtsQuery` (implicit-AND — every token must be present, right
 * for short user searches), this retrieves cells sharing *any* term, which is
 * what AD-14 health-as-confidence wants: feed a whole source cell as the query
 * and pull every validated cell that overlaps it, then let bm25 rank and the
 * coverage scorer decide. Tokenized with the same Unicode class as
 * `tokenizeForConfidence` so the terms FTS matches on are exactly the terms the
 * scorer measures coverage over. Deduped and capped at `maxTerms` to bound the
 * query size on long verses. Returns null when nothing survives.
 */
export function sanitizeFtsAnyTerm(raw: string, maxTerms = 40): string | null {
  const tokens = raw.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tokens) {
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length >= maxTerms) break
  }
  if (out.length === 0) return null
  return out.map((t) => `"${t}"`).join(" OR ")
}

// ---------------------------------------------------------------------------
// Limit helpers
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

function clampLimit(n: number | undefined): number {
  if (n === undefined) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, n))
}

// ---------------------------------------------------------------------------
// queryScopedSearch — ranked free-text search
// ---------------------------------------------------------------------------

/**
 * Run an FTS5 ranked search over `cells_fts` for the given project. The
 * project scope (`AND cells.project_id = ?`) is hardcoded — the caller
 * cannot bypass it.
 *
 * Throws on FTS5 syntax errors so the route layer can decide 400 vs 500.
 * Returns [] when the sanitizer reduces `q` to nothing.
 */
export async function queryScopedSearch(
  db: AquillaDb,
  verifiedProjectId: VerifiedProjectId,
  q: string,
  opts: { side?: "source" | "target"; limit?: number },
): Promise<SearchResultOut[]> {
  const ftsQuery = sanitizeFtsQuery(q)
  if (!ftsQuery) return []

  const limit = clampLimit(opts.limit)

  // FTS5 JOIN: cells_fts.rowid lines up with cells.rowid via the virtual
  // table's external-content binding (migration 0003).
  //   snippet(table, col, start, end, ellipsis, max_tokens)
  //     col=0 → the only column we indexed ("value")
  //     start/end → <mark>/</mark> highlight tags
  //     ellipsis → "..." for truncated tails
  //     max_tokens → 16, plenty for "saw the match in context" UX
  // Postgres FTS over the generated cells.value_tsv. plainto_tsquery ANDs all
  // terms (implicit-AND, matching the FTS5 sanitizer intent); ts_headline gives
  // the <mark> snippet; ts_rank is relevance (higher = better → ORDER BY DESC).
  const parts: string[] = [
    "SELECT",
    "  cells.cell_id AS cell_id,",
    "  cells.file_id AS file_id,",
    "  cells.side AS side,",
    "  cells.value AS value,",
    "  ts_headline('simple', cells.value, plainto_tsquery('simple', ?), 'StartSel=<mark>,StopSel=</mark>,MaxWords=16,MinWords=1,MaxFragments=1') AS snippet,",
    "  ts_rank(cells.value_tsv, plainto_tsquery('simple', ?)) AS rank",
    "FROM cells",
    "WHERE cells.value_tsv @@ plainto_tsquery('simple', ?)",
    "AND cells.project_id = ?",
  ]
  const binds: unknown[] = [q, q, q, verifiedProjectId]

  if (opts.side !== undefined) {
    parts.push("AND cells.side = ?")
    binds.push(opts.side)
  }
  parts.push("ORDER BY rank DESC")
  parts.push("LIMIT ?")
  binds.push(limit)

  const sql = parts.join(" ")

  const result = await db.prepare(sql).bind(...binds).all<SearchRowRaw>()
  return result.results.map((row) => ({
    cellId: row.cell_id,
    fileId: row.file_id,
    side: row.side,
    value: row.value,
    snippet: row.snippet,
    rank: row.rank,
  }))
}

// ---------------------------------------------------------------------------
// queryScopedExact — ordered-phrase search with paired-side value
// ---------------------------------------------------------------------------

/**
 * Run an FTS5 exact-phrase search over `cells_fts` for the given project,
 * and LEFT JOIN back to `cells` to fetch the opposite-side cell value at
 * the same (file_id, cell_id). Useful for the parallel-passages UI that
 * shows a source match next to its translation (or vice-versa).
 *
 * The project scope (`AND cells.project_id = ?`) is hardcoded — the caller
 * cannot bypass it.
 *
 * Throws on FTS5 syntax errors. Returns [] when `exactText` sanitizes away.
 */
export async function queryScopedExact(
  db: AquillaDb,
  verifiedProjectId: VerifiedProjectId,
  exactText: string,
  opts: { side?: "source" | "target"; limit?: number },
): Promise<ParallelPassageRow[]> {
  const ftsQuery = sanitizeFtsExactPhrase(exactText)
  if (!ftsQuery) return []

  const limit = clampLimit(opts.limit)

  // The LEFT JOIN on `paired` fetches the opposite-side cell at the same
  // logical address. CASE flips source↔target so one query covers both
  // directions. `paired.value` is null when no paired row exists.
  // Postgres FTS: phraseto_tsquery requires the terms adjacent + in order
  // (matching the FTS5 exact-phrase intent).
  const parts: string[] = [
    "SELECT",
    "  cells.cell_id AS cell_id,",
    "  cells.file_id AS file_id,",
    "  cells.side AS side,",
    "  cells.value AS value,",
    "  ts_headline('simple', cells.value, phraseto_tsquery('simple', ?), 'StartSel=<mark>,StopSel=</mark>,MaxWords=16,MinWords=1,MaxFragments=1') AS snippet,",
    "  ts_rank(cells.value_tsv, phraseto_tsquery('simple', ?)) AS rank,",
    "  paired.value AS paired_value",
    "FROM cells",
    "LEFT JOIN cells AS paired",
    "  ON  paired.project_id = cells.project_id",
    "  AND paired.file_id    = cells.file_id",
    "  AND paired.cell_id    = cells.cell_id",
    "  AND paired.side       = CASE cells.side WHEN 'source' THEN 'target' ELSE 'source' END",
    "WHERE cells.value_tsv @@ phraseto_tsquery('simple', ?)",
    "AND cells.project_id = ?",
  ]
  const binds: unknown[] = [exactText, exactText, exactText, verifiedProjectId]

  if (opts.side !== undefined) {
    parts.push("AND cells.side = ?")
    binds.push(opts.side)
  }
  parts.push("ORDER BY rank DESC")
  parts.push("LIMIT ?")
  binds.push(limit)

  const sql = parts.join(" ")

  const result = await db.prepare(sql).bind(...binds).all<ExactRowRaw>()
  return result.results.map((row) => ({
    cellId: row.cell_id,
    fileId: row.file_id,
    side: row.side,
    value: row.value,
    snippet: row.snippet,
    rank: row.rank,
    pairedValue: row.paired_value,
  }))
}

// ---------------------------------------------------------------------------
// queryValidatedNeighbors — AD-14 health-as-confidence candidate retrieval
// ---------------------------------------------------------------------------

/** A validated cell whose SOURCE lexically overlaps the query source text. */
export interface ValidatedNeighbor {
  cellId: string
  /** The neighbor's SOURCE value (retrieval key; kept for observability). */
  value: string
  /** The neighbor's validated TARGET value — what the scorer compares against. */
  targetValue: string
  /** FTS5 bm25 rank (more negative = better). */
  rank: number
}

/**
 * Retrieve up to `topK` validated cells whose SOURCE lexically overlaps
 * `queryText` (the asking cell's source), ranked by FTS5 bm25, returning each
 * neighbor's validated TARGET.
 *
 * This is the one-hop example set for health-as-confidence, framed as a
 * counterfactual: "if the validated cells this source retrieves were your
 * few-shot examples, does your translation look like theirs?" Retrieval is by
 * source (the stable key for "what would I translate this from"); the caller
 * scores the asking cell's TARGET against these neighbors' TARGETS — so a
 * familiar source with a wrong translation scores low. Excludes `excludeCellId`
 * so a cell never endorses itself. SQL stays here (the project-scoped FTS
 * choke-point); scoring is the caller's pure function. Returns [] when the
 * query sanitizes away.
 */
export async function querySourceNeighbors(
  db: AquillaDb,
  verifiedProjectId: VerifiedProjectId,
  queryText: string,
  opts: { topK?: number; excludeCellId?: string; validatedOnly?: boolean },
): Promise<ValidatedNeighbor[]> {
  // Any-term OR retrieval over Postgres FTS: build a `t1 | t2 | …` tsquery from
  // the same Unicode tokenization the confidence scorer uses.
  const tokens = [...new Set(queryText.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])].slice(0, 40)
  if (tokens.length === 0) return []
  const tsq = tokens.join(" | ")

  const limit = clampLimit(opts.topK)

  const parts: string[] = [
    "SELECT c.cell_id AS cell_id, c.value AS value, t.value AS target_value, ts_rank(c.value_tsv, to_tsquery('simple', ?)) AS rank",
    "FROM cells c",
    "JOIN cells t",
    "  ON  t.project_id = c.project_id",
    "  AND t.file_id    = c.file_id",
    "  AND t.cell_id    = c.cell_id",
    "  AND t.side       = 'target'",
    "  AND t.value     != ''", // translated neighbors only — need a target to compare
    "WHERE c.value_tsv @@ to_tsquery('simple', ?)",
    "AND c.project_id = ?",
    "AND c.side = 'source'",
  ]
  const binds: unknown[] = [tsq, tsq, verifiedProjectId]

  // Health propagation flows from ANY translated neighbor's health (one hop),
  // so by default we don't restrict to validated; the caller anchors at
  // validated cells separately. `validatedOnly` keeps the original behavior.
  if (opts.validatedOnly) {
    parts.push("AND t.validated = 1")
  }
  if (opts.excludeCellId !== undefined) {
    parts.push("AND c.cell_id != ?")
    binds.push(opts.excludeCellId)
  }
  parts.push("ORDER BY rank DESC")
  parts.push("LIMIT ?")
  binds.push(limit)

  const sql = parts.join(" ")
  const result = await db.prepare(sql).bind(...binds).all<{
    cell_id: string
    value: string
    target_value: string
    rank: number
  }>()
  return result.results.map((row) => ({
    cellId: row.cell_id,
    value: row.value,
    targetValue: row.target_value,
    rank: row.rank,
  }))
}

// ---------------------------------------------------------------------------
// queryFileSourceNeighbors — batched (single-query) health-as-confidence retrieval
// ---------------------------------------------------------------------------

/** Default cap on askers processed per file — mirrors the routes' MAX_FILE_CELLS. */
const DEFAULT_MAX_ASKERS = 5000
/** Cap on OR-terms per asker — mirrors the 40-term slice in querySourceNeighbors. */
const MAX_QUERY_TERMS = 40

/**
 * Batched replacement for the per-cell `querySourceNeighbors` N+1 (AQU-641).
 *
 * For EVERY translated-but-unvalidated source cell in `fileId` (the "askers"),
 * retrieve its top-`topK` source-similar, translated neighbor cells **within the
 * same file** — in a SINGLE SQL statement, via `JOIN LATERAL`. The confidence
 * routes only ever keep same-file neighbors (health propagates within the open
 * file), so scoping the retrieval to the file is behaviour-preserving and lets
 * one query do the work of one-FTS-query-per-cell.
 *
 * The asker's any-term OR tsquery is reconstructed in SQL from its stored
 * `value_tsv` lexemes (`'t1' | 't2' | …`), matching the `'simple'` config the
 * generated column uses. Each lexeme is single-quoted (and any stray quote
 * stripped) so `to_tsquery` never hits a syntax error on punctuated tokens.
 *
 * Returns a map asker `cellId → neighbors[]` (empty map entry omitted). Edge
 * weights (r/a) are still the caller's pure-JS `lexicalConfidence` — this only
 * moves the *retrieval* off the per-cell path.
 */
export async function queryFileSourceNeighbors(
  db: AquillaDb,
  verifiedProjectId: VerifiedProjectId,
  fileId: string,
  opts: { topK?: number; maxAskers?: number },
): Promise<Map<string, ValidatedNeighbor[]>> {
  const topK = clampLimit(opts.topK)
  const maxAskers = opts.maxAskers ?? DEFAULT_MAX_ASKERS

  // One statement:
  //   askers = translated + unvalidated source cells in the file
  //   q      = OR-tsquery rebuilt from each asker's value_tsv lexemes
  //   n      = top-k same-file translated source neighbors by ts_rank
  const sql =
    "WITH askers AS (" +
    "  SELECT s.cell_id AS asker_id, s.value_tsv AS asker_tsv" +
    "  FROM cells s" +
    "  JOIN cells t" +
    "    ON t.project_id = s.project_id AND t.file_id = s.file_id" +
    "   AND t.cell_id = s.cell_id AND t.side = 'target'" +
    "  WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source'" +
    "    AND t.value <> '' AND t.validated = 0" +
    "  LIMIT ?" +
    ") " +
    "SELECT a.asker_id AS asker_id, n.cell_id AS cell_id, n.value AS value," +
    "       n.target_value AS target_value, n.rank AS rank " +
    "FROM askers a " +
    "CROSS JOIN LATERAL (" +
    "  SELECT string_agg('''' || replace(lx.lexeme, '''', '') || '''', ' | ') AS terms" +
    "  FROM (SELECT lexeme FROM unnest(a.asker_tsv) LIMIT " + MAX_QUERY_TERMS + ") lx" +
    ") q " +
    "JOIN LATERAL (" +
    "  SELECT c.cell_id AS cell_id, c.value AS value, tc.value AS target_value," +
    "         ts_rank(c.value_tsv, to_tsquery('simple', q.terms)) AS rank" +
    "  FROM cells c" +
    "  JOIN cells tc" +
    "    ON tc.project_id = c.project_id AND tc.file_id = c.file_id" +
    "   AND tc.cell_id = c.cell_id AND tc.side = 'target' AND tc.value <> ''" +
    "  WHERE c.project_id = ? AND c.file_id = ? AND c.side = 'source'" +
    "    AND c.cell_id <> a.asker_id" +
    "    AND c.value_tsv @@ to_tsquery('simple', q.terms)" +
    "  ORDER BY rank DESC" +
    "  LIMIT ?" +
    ") n ON q.terms IS NOT NULL"

  const result = await db
    .prepare(sql)
    .bind(verifiedProjectId, fileId, maxAskers, verifiedProjectId, fileId, topK)
    .all<{ asker_id: string; cell_id: string; value: string; target_value: string; rank: number }>()

  const byAsker = new Map<string, ValidatedNeighbor[]>()
  for (const row of result.results ?? []) {
    const list = byAsker.get(row.asker_id)
    const neighbor: ValidatedNeighbor = {
      cellId: row.cell_id,
      value: row.value,
      targetValue: row.target_value,
      rank: row.rank,
    }
    if (list) list.push(neighbor)
    else byAsker.set(row.asker_id, [neighbor])
  }
  return byAsker
}
