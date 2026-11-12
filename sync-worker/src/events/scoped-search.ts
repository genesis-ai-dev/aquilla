// Scoped search helpers — Step 5 of the v3 search permission model.
//
// This module is the SINGLE choke-point for all FTS5 cell-search queries.
// Every search surface MUST route through `queryScopedSearch`,
// `queryScopedPattern`, or `queryScopedExact` — each accepts a
// `VerifiedProjectId` rather than a raw
// string, so passing an un-verified projectId is a TypeScript compile error.
//
// The permission boundary is structural, not advisory:
//   - `VerifiedProjectId` is a branded type that only `makeVerifiedProjectId`
//     can produce.
//   - `makeVerifiedProjectId` only accepts a `SyncTokenClaims` object — which
//     can only be obtained after JWT verification passes in auth.ts.
//   - The `AND cells.project_id = ?` predicate is hardcoded here, not supplied
//     by the caller, so it cannot be accidentally omitted.

import { targetVisibilityClause } from "./lane-read-wall"
import type { SyncTokenClaims } from "../auth"
import { targetLaneDualReadBinds, targetLaneDualReadSql } from "./lane-id-sql"
import { notHiddenSql, visibleSourceSql } from "./hidden-cells-scope"
import { inCountedFileSql } from "../../../db/shared/counted-files"
import { wireLegacyTagSql } from "../../../db/shared/lane-sql"
import {
  findPatternError,
  findTextMatches,
  markedSnippet,
  postgresCanRunRegexp,
  type TextFindOptions,
} from "../../../db/shared/find-pattern"
import { withLongOperationTimeout } from "../../../db/shim/postgres"

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
  /**
   * The opposite-side cell value at the same (file_id, cell_id), if it
   * exists. null when there is no paired cell (e.g. a target row whose
   * source was never imported). Find & Replace shows this so a reviewer
   * can check the source without leaving the panel (AQU-1011).
   */
  pairedValue: string | null
  /**
   * Verse address for this cell, taken from the source row when the matched
   * row (often the target) has none. `GEN 1:1`. Null when the cell has no
   * canonical reference.
   */
  canonicalRef: string | null
  /** Source cell type (`verse`, `heading`, `paratext`, …). Null when unset. */
  cellType: string | null
  /**
   * A human label stored on the cell (section title, cell label, cast name,
   * or import display label). Null when the cell has none. May still be a
   * bare number or an id — the client decides whether it is readable.
   */
  placeLabel: string | null
  /** 1-based place of this cell among the file's visible source cells. */
  position: number | null
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

interface LocationRowRaw {
  canonical_ref: string | null
  cell_type: string | null
  place_label: string | null
  position: number | string | null
}

interface SearchRowRaw extends LocationRowRaw {
  cell_id: string
  file_id: string
  side: "source" | "target"
  value: string
  snippet: string
  rank: number
  paired_value: string | null
}

/**
 * Where a hit sits, so Find & Replace can name the verse instead of the
 * file and cell ids. The source row owns the address: a target hit often
 * has a null `canonical_ref` of its own. `position` counts visible source
 * cells in file order so a notes row can be "file name, line N".
 */
const LOCATION_SELECT = `
  COALESCE(loc.source_canonical_ref, NULLIF(BTRIM(cells.canonical_ref), '')) AS canonical_ref,
  COALESCE(loc.source_type, NULLIF(BTRIM(cells.type), '')) AS cell_type,
  COALESCE(
    loc.source_place_label,
    NULLIF(BTRIM(cells.metadata #>> '{aquillaImport,milestone,label}'), ''),
    NULLIF(BTRIM(cells.metadata #>> '{cellLabel}'), ''),
    NULLIF(BTRIM(cells.metadata #>> '{cast_name}'), ''),
    NULLIF(BTRIM(cells.metadata #>> '{aquillaImport,displayLabel}'), '')
  ) AS place_label,
  (
    SELECT 1 + COUNT(*)::int
    FROM cells AS earlier
    WHERE earlier.project_id = cells.project_id
      AND earlier.file_id = cells.file_id
      AND earlier.side = 'source'
      AND earlier.hidden_at IS NULL
      AND earlier.cell_id <> cells.cell_id
      AND (COALESCE(earlier.sequence_index, 1e300), earlier.cell_id)
        < (COALESCE(loc.source_sequence, 1e300), cells.cell_id)
  ) AS position`

const LOCATION_FROM = `LEFT JOIN LATERAL (
  SELECT
    NULLIF(BTRIM(src.canonical_ref), '') AS source_canonical_ref,
    NULLIF(BTRIM(src.type), '') AS source_type,
    src.sequence_index AS source_sequence,
    COALESCE(
      NULLIF(BTRIM(src.metadata #>> '{aquillaImport,milestone,label}'), ''),
      NULLIF(BTRIM(src.metadata #>> '{cellLabel}'), ''),
      NULLIF(BTRIM(src.metadata #>> '{cast_name}'), ''),
      NULLIF(BTRIM(src.metadata #>> '{aquillaImport,displayLabel}'), '')
    ) AS source_place_label
  FROM cells AS src
  WHERE src.project_id = cells.project_id
    AND src.file_id = cells.file_id
    AND src.cell_id = cells.cell_id
    AND src.side = 'source'
  LIMIT 1
) AS loc ON TRUE`

function locationFromRow(row: LocationRowRaw): Pick<
  SearchResultOut,
  "canonicalRef" | "cellType" | "placeLabel" | "position"
> {
  const position = row.position == null || row.position === "" ? null : Number(row.position)
  return {
    canonicalRef: row.canonical_ref?.trim() || null,
    cellType: row.cell_type?.trim() || null,
    placeLabel: row.place_label?.trim() || null,
    position: position != null && Number.isFinite(position) ? position : null,
  }
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
/** Rows read when a regexp cannot be pushed into Postgres. A Bible is ~31k verses a side. */
const PATTERN_SCAN_CAP = 80_000

function clampLimit(n: number | undefined): number {
  if (n === undefined) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, n))
}

// ---------------------------------------------------------------------------
// queryScopedSearch — ranked free-text search
// ---------------------------------------------------------------------------

/**
 * Lane read wall for search. `null` = every lane. A walled caller sees source
 * rows plus target rows in their granted lanes — for the matched row AND for
 * the opposite-side `paired` value, which would otherwise leak another lane's
 * translation through a source-side hit.
 */
export type SearchLaneWall = readonly string[] | null

function wallFor(alias: string, laneIds: SearchLaneWall): { sql: string; binds: unknown[] } {
  return (
    targetVisibilityClause({ laneIds, sideExpr: `${alias}.side`, laneIdExpr: `${alias}.lane_id` }) ?? {
      sql: "",
      binds: [],
    }
  )
}

/** Pairing subselect: the opposite-side value, restricted to visible lanes. */
function pairedSubselect(laneIds: SearchLaneWall): { sql: string; binds: unknown[] } {
  const w = wallFor("paired", laneIds)
  return {
    sql: [
      "  (SELECT paired.value FROM cells AS paired",
      "    WHERE paired.project_id = cells.project_id",
      "      AND paired.file_id = cells.file_id",
      "      AND paired.cell_id = cells.cell_id",
      "      AND paired.side = CASE cells.side WHEN 'source' THEN 'target' ELSE 'source' END",
      `    ${w.sql}`,
      "    LIMIT 1) AS paired_value,",
    ].join(" "),
    binds: w.binds,
  }
}

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
  opts: { side?: "source" | "target"; limit?: number; laneIds: SearchLaneWall },
): Promise<SearchResultOut[]> {
  const ftsQuery = sanitizeFtsQuery(q)
  if (!ftsQuery) return []

  const limit = clampLimit(opts.limit)
  const paired = pairedSubselect(opts.laneIds)
  const cellWall = wallFor("cells", opts.laneIds)

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
    "  ts_rank(cells.value_tsv, plainto_tsquery('simple', ?)) AS rank,",
    // One opposite-side value, never a row multiplier. A target hit has a
    // single source lane; a source hit may have several target lanes, and
    // LIMIT 1 keeps the hit list one row per matched cell (AQU-1011).
    paired.sql,
    LOCATION_SELECT,
    "FROM cells",
    LOCATION_FROM,
    "WHERE cells.value_tsv @@ plainto_tsquery('simple', ?)",
    "AND cells.project_id = ?",
    // AQU-1424: a parked cell is not searchable. The anti-join is required
    // rather than `cells.hidden_at IS NULL` because this query matches EITHER
    // side and the flag lives only on the shared source row — reading it off the
    // matched row would let every target-side hit through. It also settles
    // Find & Replace, whose candidates are these results.
    `AND ${notHiddenSql("cells")}`,
    // AQU-1626: and neither is a cell inside a deleted file or a hidden
    // companion (a cue sheet, a caption track). A cue is timecode text, so
    // searching a dubbed project returned pages of machine rows above the
    // script the person was actually looking for.
    `AND ${inCountedFileSql("cells")}`,
  ]
  const binds: unknown[] = [q, q, ...paired.binds, q, verifiedProjectId]

  if (opts.side !== undefined) {
    parts.push("AND cells.side = ?")
    binds.push(opts.side)
  }
  if (cellWall.sql) {
    parts.push(cellWall.sql)
    binds.push(...cellWall.binds)
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
    pairedValue: row.paired_value ?? null,
    ...locationFromRow(row),
  }))
}

// ---------------------------------------------------------------------------
// queryScopedPattern — match case / whole word / regexp
// ---------------------------------------------------------------------------

export interface PatternSearchOptions extends TextFindOptions {
  laneIds: SearchLaneWall
  side?: "source" | "target"
  limit?: number
}

/**
 * Project-scoped search that honors the find-widget flags. The default FTS
 * path stays in `queryScopedSearch`; this runs only when match case, whole
 * word, or regexp is on, and the hits are whatever `findTextMatches` accepts
 * so Replace highlights the same spans the list returned.
 *
 * A literal query is a `position()` filter (case via `lower`). A regular
 * expression Postgres ARE can run is a `~` / `~*` filter. JavaScript-only
 * constructs (`\b`, lookaround, `\p{}`) are matched in the worker after a
 * project-scoped read, because sending them to `~` would search for the wrong
 * thing (`\b` is a backspace in ARE).
 */
export async function queryScopedPattern(
  db: AquillaDb,
  verifiedProjectId: VerifiedProjectId,
  q: string,
  opts: PatternSearchOptions,
): Promise<SearchResultOut[]> {
  const find: TextFindOptions = {
    matchCase: opts.matchCase === true,
    wholeWord: opts.wholeWord === true,
    useRegexp: opts.useRegexp === true,
  }
  if (findPatternError(q, find)) throw new Error("invalid regexp")

  const limit = clampLimit(opts.limit)
  const paired = pairedSubselect(opts.laneIds)
  const cellWall = wallFor("cells", opts.laneIds)
  const pgRegexp = find.useRegexp === true && postgresCanRunRegexp(q)
  const fetchLimit = find.useRegexp === true && !pgRegexp
    ? PATTERN_SCAN_CAP
    : find.wholeWord || find.useRegexp
      ? MAX_LIMIT
      : limit

  const parts: string[] = [
    "SELECT",
    "  cells.cell_id AS cell_id,",
    "  cells.file_id AS file_id,",
    "  cells.side AS side,",
    "  cells.value AS value,",
    paired.sql,
    LOCATION_SELECT,
    "FROM cells",
    LOCATION_FROM,
    "WHERE cells.project_id = ?",
    `AND ${notHiddenSql("cells")}`,
    `AND ${inCountedFileSql("cells")}`,
  ]
  const binds: unknown[] = [...paired.binds, verifiedProjectId]

  if (!find.useRegexp) {
    parts.push(
      find.matchCase
        ? "AND position(? in cells.value) > 0"
        : "AND position(lower(?) in lower(cells.value)) > 0",
    )
    binds.push(q)
  } else if (pgRegexp) {
    parts.push(find.matchCase ? "AND cells.value ~ ?" : "AND cells.value ~* ?")
    binds.push(q)
  }

  if (opts.side !== undefined) {
    parts.push("AND cells.side = ?")
    binds.push(opts.side)
  }
  if (cellWall.sql) {
    parts.push(cellWall.sql)
    binds.push(...cellWall.binds)
  }
  parts.push("ORDER BY cells.cell_id, cells.side")
  parts.push("LIMIT ?")
  binds.push(fetchLimit)

  let result: { results: PatternRowRaw[] }
  try {
    result = await db.prepare(parts.join(" ")).bind(...binds).all<PatternRowRaw>()
  } catch (err) {
    // JS accepted the pattern and Postgres did not. Match in the worker
    // instead of failing the search.
    const message = err instanceof Error ? err.message : String(err)
    if (!pgRegexp || !/invalid regular expression/i.test(message)) throw err
    const scanParts = parts.filter((part) => !part.startsWith("AND cells.value ~"))
    const scanBinds = binds.filter((_, i) => i !== paired.binds.length + 1)
    scanBinds[scanBinds.length - 1] = PATTERN_SCAN_CAP
    result = await db.prepare(scanParts.join(" ")).bind(...scanBinds).all<PatternRowRaw>()
  }
  const out: SearchResultOut[] = []
  for (const row of result.results) {
    const hits = findTextMatches(row.value, q, find)
    if (hits.length === 0) continue
    out.push({
      cellId: row.cell_id,
      fileId: row.file_id,
      side: row.side,
      value: row.value,
      snippet: markedSnippet(row.value, hits[0]),
      rank: hits[0].index,
      pairedValue: row.paired_value ?? null,
      ...locationFromRow(row),
    })
    if (out.length >= limit) break
  }
  return out
}

interface PatternRowRaw extends LocationRowRaw {
  cell_id: string
  file_id: string
  side: "source" | "target"
  value: string
  paired_value: string | null
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
  opts: { side?: "source" | "target"; limit?: number; laneIds: SearchLaneWall },
): Promise<ParallelPassageRow[]> {
  const ftsQuery = sanitizeFtsExactPhrase(exactText)
  if (!ftsQuery) return []

  const limit = clampLimit(opts.limit)
  const pairedWall = wallFor("paired", opts.laneIds)
  const cellWall = wallFor("cells", opts.laneIds)

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
    "  paired.value AS paired_value,",
    LOCATION_SELECT,
    "FROM cells",
    LOCATION_FROM,
    "LEFT JOIN cells AS paired",
    "  ON  paired.project_id = cells.project_id",
    "  AND paired.file_id    = cells.file_id",
    "  AND paired.cell_id    = cells.cell_id",
    "  AND paired.side       = CASE cells.side WHEN 'source' THEN 'target' ELSE 'source' END",
    pairedWall.sql,
    "WHERE cells.value_tsv @@ phraseto_tsquery('simple', ?)",
    "AND cells.project_id = ?",
    // AQU-1424: as in queryScoped — parked cells leave the results, and with
    // them the Find & Replace candidate list built from those results.
    `AND ${notHiddenSql("cells")}`,
    // AQU-1626: likewise deleted files and hidden companions. This one matters
    // twice over: Find & Replace WRITES to what it finds, and a replace into a
    // cue sheet corrupts a timecode nobody was editing.
    `AND ${inCountedFileSql("cells")}`,
  ]
  const binds: unknown[] = [exactText, exactText, ...pairedWall.binds, exactText, verifiedProjectId]

  if (opts.side !== undefined) {
    parts.push("AND cells.side = ?")
    binds.push(opts.side)
  }
  if (cellWall.sql) {
    parts.push(cellWall.sql)
    binds.push(...cellWall.binds)
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
    ...locationFromRow(row),
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
/**
 * Any-term OR tsquery (`t1 | t2 | …`) from the same Unicode tokenization the
 * confidence scorer uses. Null when nothing tokenizable survives.
 */
function neighborTsquery(queryText: string): string | null {
  const tokens = [...new Set(queryText.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])].slice(0, 40)
  return tokens.length > 0 ? tokens.join(" | ") : null
}

export async function querySourceNeighbors(
  db: AquillaDb,
  verifiedProjectId: VerifiedProjectId,
  queryText: string,
  opts: { topK?: number; excludeCellId?: string; validatedOnly?: boolean },
): Promise<ValidatedNeighbor[]> {
  const tsq = neighborTsquery(queryText)
  if (tsq === null) return []

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
    // AQU-1424: a parked cell is neither a neighbor nor a precedent. `c` IS the
    // source row here, so the flag can be read off it directly.
    `AND ${visibleSourceSql("c")}`,
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
// querySimilarSourceCells — AQU-1232 agent-memory retrieval
// ---------------------------------------------------------------------------

/** A source cell that lexically overlaps the query text, with its target. */
export interface SimilarSourceCell {
  cellId: string
  fileId: string
  /** The candidate's SOURCE value — the retrieval key. */
  sourceValue: string
  /** The candidate's current TARGET value (the rendering to reuse). */
  targetValue: string
  /** Target-language lane the target lives in ('' = the default lane). */
  targetLang: string
  /** Postgres ts_rank of the candidate against the query terms. Used only to
   *  order the candidate POOL; the score returned to callers is the pure-JS
   *  Jaccard in lexical-confidence.ts (ts_rank is unnormalized and length-
   *  sensitive, so it is not a similarity a caller can threshold on). */
  rank: number
}

/**
 * Retrieve up to `limit` translated source cells in the project whose SOURCE
 * lexically overlaps `queryText`, each with its current target.
 *
 * Deliberately NOT `querySourceNeighbors`: that one is the AD-14 confidence
 * hot path — same-lane, health-shaped, and returning only (cellId, value,
 * targetValue, rank). The agent-memory surface needs `fileId` and `targetLang`
 * so a caller can locate and disambiguate the rendering it is being offered,
 * and must span every lane. Widening the confidence row shape for that would
 * push extra columns through the batched `queryFileSourceNeighbors` LATERAL
 * join on the health path for no benefit there, so this stays a sibling query
 * in the same choke-point module rather than a shared one.
 *
 * v1 is LEXICAL ONLY — any-term overlap over the existing `value_tsv` full-text
 * column. No embeddings, no vector store, no new infrastructure.
 *
 * Returns [] when `queryText` has no tokenizable terms.
 */
export async function querySimilarSourceCells(
  db: AquillaDb,
  verifiedProjectId: VerifiedProjectId,
  queryText: string,
  opts: { limit?: number; excludeCellId?: string },
): Promise<SimilarSourceCell[]> {
  const tsq = neighborTsquery(queryText)
  if (tsq === null) return []

  const limit = clampLimit(opts.limit)

  const parts: string[] = [
    "SELECT c.cell_id AS cell_id, c.file_id AS file_id, c.value AS source_value,",
    "       t.value AS target_value, " + wireLegacyTagSql("t") + " AS target_lang,",
    "       ts_rank(c.value_tsv, to_tsquery('simple', ?)) AS rank",
    "FROM cells c",
    "JOIN cells t",
    "  ON  t.project_id = c.project_id",
    "  AND t.file_id    = c.file_id",
    "  AND t.cell_id    = c.cell_id",
    "  AND t.side       = 'target'",
    "  AND t.value     != ''", // a candidate without a rendering is useless here
    "WHERE c.value_tsv @@ to_tsquery('simple', ?)",
    "AND c.project_id = ?",
    "AND c.side = 'source'",
    // AQU-1424: a parked cell is neither a neighbor nor a precedent. `c` IS the
    // source row here, so the flag can be read off it directly.
    `AND ${visibleSourceSql("c")}`,
  ]
  const binds: unknown[] = [tsq, tsq, verifiedProjectId]

  if (opts.excludeCellId !== undefined) {
    // Never let a cell retrieve itself as its own precedent.
    parts.push("AND c.cell_id != ?")
    binds.push(opts.excludeCellId)
  }
  parts.push("ORDER BY rank DESC")
  parts.push("LIMIT ?")
  binds.push(limit)

  const result = await db
    .prepare(parts.join(" "))
    .bind(...binds)
    .all<{
      cell_id: string
      file_id: string
      source_value: string
      target_value: string
      target_lang: string | null
      rank: number
    }>()
  return result.results.map((row) => ({
    cellId: row.cell_id,
    fileId: row.file_id,
    sourceValue: row.source_value,
    targetValue: row.target_value,
    targetLang: row.target_lang ?? "",
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
  opts: { topK?: number; maxAskers?: number; targetLang?: string },
): Promise<Map<string, ValidatedNeighbor[]>> {
  const topK = clampLimit(opts.topK)
  const maxAskers = opts.maxAskers ?? DEFAULT_MAX_ASKERS
  // AQU-1005: retrieval is lane-scoped. '' is the single-lane default —
  // multi-lane projects store one target row per (cell, target_lang), and an
  // unscoped join would fan out per lane and mix examples across languages.
  const targetLang = opts.targetLang ?? ""

  // One statement:
  //   askers = translated + unvalidated source cells in the file (one lane)
  //   q      = OR-tsquery rebuilt from each asker's value_tsv lexemes
  //   n      = top-k same-file, same-lane translated source neighbors by ts_rank
  const sql =
    "WITH askers AS (" +
    "  SELECT s.cell_id AS asker_id, s.value_tsv AS asker_tsv" +
    "  FROM cells s" +
    "  JOIN cells t" +
    "    ON t.project_id = s.project_id AND t.file_id = s.file_id" +
    "   AND t.cell_id = s.cell_id AND t.side = 'target'" +
    "   AND " + targetLaneDualReadSql("t") +
    "  WHERE s.project_id = ? AND s.file_id = ? AND s.side = 'source'" +
    // AQU-1424: a parked cell does not ASK for neighbors either — nothing will
    // be drafted into it while it is hidden.
    "    AND " + visibleSourceSql("s") +
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
    "   AND " + targetLaneDualReadSql("tc") +
    "  WHERE c.project_id = ? AND c.file_id = ? AND c.side = 'source'" +
    // AQU-1424: and it is not offered AS a neighbor.
    "    AND " + visibleSourceSql("c") +
    "    AND c.cell_id <> a.asker_id" +
    "    AND c.value_tsv @@ to_tsquery('simple', q.terms)" +
    "  ORDER BY rank DESC" +
    "  LIMIT ?" +
    ") n ON q.terms IS NOT NULL"

  // Per-statement ceiling (AQU-1005). The unscoped predecessor of this query
  // ran for minutes on large projects and saturated the shared compute (a
  // client abort at 15s does not cancel the server-side query); the ceiling
  // turns any future regression into a fast, loud error instead of a silent
  // convoy. Since AQU-1876 the value lives in the shim's
  // LONG_OPERATION_TIMEOUTS registry, which is the one list of operations
  // allowed to outrun DEFAULT_STATEMENT_TIMEOUT_MS.
  const result = await withLongOperationTimeout(db, "confidence-neighbors")
    .prepare(sql)
    .bind(
      ...targetLaneDualReadBinds(verifiedProjectId, targetLang),
      verifiedProjectId,
      fileId,
      maxAskers,
      ...targetLaneDualReadBinds(verifiedProjectId, targetLang),
      verifiedProjectId,
      fileId,
      topK,
    )
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
