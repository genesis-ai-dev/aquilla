// Scoped search helpers — Step 5 of the v3 search permission model.
//
// This module is the SINGLE choke-point for all full-text cell-search queries.
// Every search surface MUST route through `queryScopedSearch`,
// `queryScopedPattern`, `queryScopedText`, or `queryScopedExact` (or the
// `…Page` form of each, which also says how many cells matched in all) — each
// accepts a `VerifiedProjectId` rather than a raw
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
  markedSnippetOfAll,
  needsSubstringSearch,
  postgresCanRunRegexp,
  type TextFindOptions,
  type TextMatch,
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
  /** ts_headline snippet with `<mark>...</mark>` highlights around matched terms. */
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

/**
 * One page of hits, and how many rows the search matched in all (AQU-2732).
 *
 * The page is cut at `limit`; without the total a full page of 50 reads the
 * same whether there were 50 matches or 5,000, and Replace all changed the
 * first page while saying nothing of the rest.
 */
export interface SearchPage<Row> {
  results: Row[]
  /**
   * Rows the page's own filter admits: the project, the side, the file, the
   * lane wall, and neither a parked cell nor an uncounted file. It is counted
   * by the query that produced the page, so the two cannot drift apart. Never
   * less than `results.length`.
   */
  total: number
  /**
   * True when `total` is a floor, not the count. Only `queryScopedPattern`
   * can say this: whole word and regular expressions are finally decided in
   * the worker, over a bounded read, so past that read the rest is unknown.
   */
  totalIsLowerBound: boolean
}

// ---------------------------------------------------------------------------
// Raw DB row shapes (internal only)
// ---------------------------------------------------------------------------

interface LocationRowRaw {
  canonical_ref: string | null
  cell_type: string | null
  place_label: string | null
  position: number | string | null
  /** `HIT_TOTAL_SELECT`. A bigint, so the driver may hand it over as a string. */
  total_count?: number | string | null
}

/**
 * How a page is read now that its total comes with it (AQU-2732).
 *
 * Every search here is two queries in one statement, put together by
 * `pageStatement`. The first, `hit`, is the search itself: the WHERE, its
 * ORDER BY and LIMIT, and `COUNT(*) OVER()` beside them, so one WHERE makes
 * both the page and the total and a filter added to it later is counted too.
 * It hands out nothing wider than where each matched row is. The second
 * fetches the rows of the page and does the per-row work for those alone: the
 * snippet, the opposite side, where the cell sits in its file.
 *
 * The split is what keeps the count cheap. Measured on a Bible, limit 50,
 * before the total / counted in one flat query / counted in `hit`:
 *   "the", word index, 23,210 matches     39 / 127 / 46 ms
 *   Burmese text matching, 10,452 matches 92 / 133 / 96 ms
 *   "temple", 596 matches                 13 /  12 / 12 ms
 * Flat, the window sat above the joins, so the location lookup ran for every
 * match where a bare LIMIT had run it for the page. Carrying the whole row
 * through `hit` was also tried: the window then buffers every match's text,
 * and Burmese went to 152 ms.
 *
 * What no shape avoids is reading every match once. A search ordered by rank
 * already did. A match-case search, which could stop at its first 50 in index
 * order, now reads the project to the end: 13 → 36 ms on that Bible.
 *
 * `row_id` is the row's `ctid`, its physical address. Inside one statement
 * that is exact: both reads share a snapshot, and a row version the snapshot
 * can see is neither moved nor removed while the statement runs. It is used
 * over the primary key because it needs no index: given the four key columns
 * the planner chose `idx_cells_lane_id`, at 35 µs a row. Were `cells` ever
 * partitioned, `tableoid` would have to travel with it.
 */
const HIT_SELECT = [
  "  cells.ctid AS row_id,",
  "  cells.file_id AS file_id,",
  "  cells.cell_id AS cell_id,",
  "  cells.side AS side,",
].join(" ")

/** How many rows the WHERE of `hit` admits, counted before its LIMIT cuts the page. */
const HIT_TOTAL_SELECT = "  COUNT(*) OVER() AS total_count"

/** The rows of the page. Aliased `cells`, as every fragment written against the table expects. */
const HIT_ROW_FROM = "JOIN cells ON cells.ctid = hit.row_id"

/** The count rides on every row. An empty page has no row, and matched nothing. */
function totalOf(rows: ReadonlyArray<Pick<LocationRowRaw, "total_count">>): number {
  const counted = Number(rows[0]?.total_count ?? 0)
  return Number.isFinite(counted) ? Math.max(counted, rows.length) : rows.length
}

function noMatches<Row>(): SearchPage<Row> {
  return { results: [], total: 0, totalIsLowerBound: false }
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
 * has a null `canonical_ref` of its own. `position` follows these columns;
 * see POSITION_BY_ROW.
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
  ) AS place_label,`

/**
 * `position`: the 1-based place of the hit's cell among the visible source
 * cells of its file, in file order. It is what lets a notes row be "file
 * name, line 12", and what numbers two halves of a split verse "(1 of 2)" and
 * "(2 of 2)".
 *
 * Counted a hit at a time: for each hit, every cell of its file that comes
 * before it. A book is some hundreds of cells, so this is about 0.15 ms a
 * hit on a local Bible: 8 ms for a page of 50, 75 ms for a page of 500.
 */
const POSITION_BY_ROW = `(
    SELECT 1 + COUNT(*)::int
    FROM cells AS earlier
    WHERE earlier.project_id = cells.project_id
      AND earlier.file_id = cells.file_id
      AND earlier.side = 'source'
      AND earlier.hidden_at IS NULL
      AND earlier.cell_id <> cells.cell_id
      AND (COALESCE(earlier.sequence_index, 1e300), earlier.cell_id)
        < (COALESCE(loc.source_sequence, 1e300), cells.cell_id)
  )`

/**
 * The same number, worked out a file at a time (AQU-2732): the visible source
 * cells of every file that has a hit on the page, numbered once in the same
 * order. One row per cell (the GROUP BY), so joining to it cannot multiply
 * hits even if a cell were to have two source rows.
 *
 * What this costs follows the files on the page, not the hits: about 0.6 ms a
 * book. Measured on that Bible, a hit at a time / a file at a time:
 *   "temple", project, 500 rows    81 / 30 ms
 *   "the", project, 500 rows      203 / 116 ms
 *   "temple", one file, 50 rows     7 /  2 ms
 *   "the", project, 50 rows        48 / 52 ms
 * The last line is the one case it loses: the 50 best hits of a common word
 * sit in 50 different books. `numbersPlacesByFile` picks accordingly.
 *
 * MATERIALIZED is load-bearing. Without it Postgres folds the numbering into
 * the join and redoes it for every hit (2 → 22 ms for one file).
 *
 * A hit whose cell has no visible source row, a target with no source, is in
 * no file's numbering. `pageStatement` falls back to POSITION_BY_ROW for it.
 */
const PLACE_CTE = `place AS MATERIALIZED (
  SELECT in_page.file_id AS file_id, numbered.cell_id AS cell_id, numbered.position AS position
  FROM (SELECT DISTINCT hit.file_id FROM hit) AS in_page
  CROSS JOIN LATERAL (
    SELECT visible.cell_id AS cell_id,
      ROW_NUMBER() OVER (ORDER BY visible.seq, visible.cell_id)::int AS position
    FROM (
      SELECT src.cell_id AS cell_id, MIN(COALESCE(src.sequence_index, 1e300)) AS seq
      FROM cells AS src
      WHERE src.project_id = ?
        AND src.file_id = in_page.file_id
        AND src.side = 'source'
        AND src.hidden_at IS NULL
      GROUP BY src.cell_id
    ) AS visible
  ) AS numbered
)`

const PLACE_FROM = "LEFT JOIN place ON place.file_id = cells.file_id AND place.cell_id = cells.cell_id"

/** A page of more rows than this numbers places a file at a time. */
const PLACE_BY_ROW_MAX = 100

/** See PLACE_CTE: a big page, or any page out of a single file. */
function numbersPlacesByFile(rows: number, fileId: string | undefined): boolean {
  return fileId !== undefined || rows > PLACE_BY_ROW_MAX
}

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

/** The parts of one search statement. See the note on HIT_SELECT. */
interface PageStatement {
  /** The search: SELECT … FROM cells WHERE … ORDER BY … LIMIT, as `hit` holds it. */
  hit: string[]
  hitBinds: unknown[]
  /** The outer SELECT list before the location columns. Every item ends in a comma. */
  select: string[]
  selectBinds: unknown[]
  /** Joins the outer query needs besides the row itself and its location. */
  joins?: string[]
  orderBy: string
  /** Set when the outer query is the one that cuts the page; `hit` has cut it otherwise. */
  limit?: number
  /** `numbersPlacesByFile`, for the most rows `hit` can hold. */
  placesByFile: boolean
  projectId: VerifiedProjectId
}

function pageStatement(page: PageStatement): { sql: string; binds: unknown[] } {
  const byFile = page.placesByFile
  const sql = [
    "WITH hit AS (",
    ...page.hit,
    ")",
    ...(byFile ? [",", PLACE_CTE] : []),
    "SELECT",
    ...page.select,
    LOCATION_SELECT,
    byFile ? `COALESCE(place.position, ${POSITION_BY_ROW}) AS position` : `${POSITION_BY_ROW} AS position`,
    "FROM hit",
    HIT_ROW_FROM,
    ...(page.joins ?? []),
    LOCATION_FROM,
    ...(byFile ? [PLACE_FROM] : []),
    `ORDER BY ${page.orderBy}`,
    ...(page.limit === undefined ? [] : ["LIMIT ?"]),
  ].join(" ")
  // In the order the placeholders appear in the statement.
  const binds = [
    ...page.hitBinds,
    ...(byFile ? [page.projectId] : []),
    ...page.selectBinds,
    ...(page.limit === undefined ? [] : [page.limit]),
  ]
  return { sql, binds }
}

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
 * Reduce a free-text query to the tokens a search can actually match on.
 * Drops query-syntax punctuation and the reserved keywords AND/OR/NOT/NEAR,
 * then quotes each survivor so the result reads as a token sequence rather
 * than an operator expression.
 *
 * Returns null when nothing survives (e.g. the user typed only punctuation).
 * Callers should treat null as "no results".
 *
 * On Postgres the RETURN VALUE is a gate, not a query: `queryScopedSearch`
 * uses it only to decide whether to run at all, and binds the raw text to
 * `plainto_tsquery`, which does its own parsing. The quoted form is still
 * asserted by the test suite, so it is part of this function's contract.
 */
export function sanitizeFtsQuery(raw: string): string | null {
  // Drop query-syntax punctuation: quotes, parens, colons, asterisks, pluses,
  // minuses. Keep letters, digits, whitespace, and dashes-internal-to-words
  // (we collapse runs of non-word into a single space below).
  const cleaned = raw.replace(/["()*:+-]/g, " ")
  // Split into bare tokens; reject the reserved keywords case-insensitively
  // by lowercasing the comparison.
  const RESERVED = new Set(["and", "or", "not", "near"])
  const tokens = cleaned
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .filter((t) => !RESERVED.has(t.toLowerCase()))
  if (tokens.length === 0) return null
  // Wrap each token in double quotes — `"foo"` reads as a single-token
  // phrase, sidestepping any remaining parse ambiguity.
  return tokens.map((t) => `"${t}"`).join(" ")
}

/**
 * Sanitize a phrase for adjacent-phrase (ordered) matching. Like
 * `sanitizeFtsQuery` in cleanup, but wraps the whole token sequence in a
 * single pair of double quotes so it reads as one contiguous phrase —
 * `"token1 token2 token3"` means those tokens in that exact order with no
 * gaps. As above, `queryScopedExact` uses the result only as a gate and binds
 * the raw text to `phraseto_tsquery`.
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
  // Single quoted phrase — the exact token sequence, in order.
  return '"' + tokens.join(" ") + '"'
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
 * Run a ranked full-text search over `cells.value_tsv` for the given
 * project. The project scope (`AND cells.project_id = ?`) is hardcoded — the
 * caller cannot bypass it.
 *
 * A query in a script the word index cannot search (see
 * `needsSubstringSearch`) is not answered from the index at all: it goes to
 * `queryScopedText`, which matches each typed word as text and ranks the
 * hits itself.
 *
 * Throws on tsquery syntax errors so the route layer can decide 400 vs 500.
 * Returns [] when the sanitizer reduces `q` to nothing.
 */
export async function queryScopedSearch(
  db: AquillaDb,
  verifiedProjectId: VerifiedProjectId,
  q: string,
  opts: { side?: "source" | "target"; limit?: number; laneIds: SearchLaneWall; fileId?: string },
): Promise<SearchResultOut[]> {
  return (await queryScopedSearchPage(db, verifiedProjectId, q, opts)).results
}

/** `queryScopedSearch`, with the number of cells that matched in all. */
export async function queryScopedSearchPage(
  db: AquillaDb,
  verifiedProjectId: VerifiedProjectId,
  q: string,
  opts: { side?: "source" | "target"; limit?: number; laneIds: SearchLaneWall; fileId?: string },
): Promise<SearchPage<SearchResultOut>> {
  const ftsQuery = sanitizeFtsQuery(q)
  if (!ftsQuery) return noMatches()

  // `value_tsv` holds words, and a script written without spaces has none to
  // hold: 一切銅器皿 is ONE lexeme, so 器皿 is not in the index. Worse than a
  // plain miss, 、器皿、 does index it, and the index would then return that
  // one cell as though it were the whole answer. Korean fails the same way
  // from the other direction (하나님이 is indexed, 하나님 is not). Match these
  // as text.
  if (needsSubstringSearch(q)) {
    return queryScopedTextPage(db, verifiedProjectId, q, {
      side: opts.side,
      limit: opts.limit,
      laneIds: opts.laneIds,
      fileId: opts.fileId,
    })
  }

  const limit = clampLimit(opts.limit)
  const paired = pairedSubselect(opts.laneIds)
  const cellWall = wallFor("cells", opts.laneIds)

  // Postgres FTS over the generated cells.value_tsv column and its GIN index.
  //   plainto_tsquery → ANDs every term, matching the sanitizer's intent that
  //     all of what the translator typed must be present.
  //   ts_headline → the <mark>…</mark> snippet; MaxWords=16 is plenty for
  //     "saw the match in context" UX, MaxFragments=1 keeps it to one line.
  //   ts_rank → relevance, HIGHER is better, hence ORDER BY rank DESC.
  const hit: string[] = [
    "SELECT",
    HIT_SELECT,
    "  ts_rank(cells.value_tsv, plainto_tsquery('simple', ?)) AS rank,",
    HIT_TOTAL_SELECT,
    "FROM cells",
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
  const hitBinds: unknown[] = [q, q, verifiedProjectId]

  if (opts.side !== undefined) {
    hit.push("AND cells.side = ?")
    hitBinds.push(opts.side)
  }
  // "Search this file" has to narrow the query, not the page it returns: the
  // LIMIT below is taken across whatever this WHERE admits.
  if (opts.fileId !== undefined) {
    hit.push("AND cells.file_id = ?")
    hitBinds.push(opts.fileId)
  }
  if (cellWall.sql) {
    hit.push(cellWall.sql)
    hitBinds.push(...cellWall.binds)
  }
  hit.push("ORDER BY rank DESC", "LIMIT ?")
  hitBinds.push(limit)

  const { sql, binds } = pageStatement({
    hit,
    hitBinds,
    select: [
      "  cells.cell_id AS cell_id,",
      "  cells.file_id AS file_id,",
      "  cells.side AS side,",
      "  cells.value AS value,",
      "  ts_headline('simple', cells.value, plainto_tsquery('simple', ?), 'StartSel=<mark>,StopSel=</mark>,MaxWords=16,MinWords=1,MaxFragments=1') AS snippet,",
      "  hit.rank AS rank,",
      "  hit.total_count AS total_count,",
      // One opposite-side value, never a row multiplier. A target hit has a
      // single source lane; a source hit may have several target lanes, and
      // LIMIT 1 keeps the hit list one row per matched cell (AQU-1011).
      paired.sql,
    ],
    selectBinds: [q, ...paired.binds],
    orderBy: "hit.rank DESC",
    placesByFile: numbersPlacesByFile(limit, opts.fileId),
    projectId: verifiedProjectId,
  })

  const result = await db.prepare(sql).bind(...binds).all<SearchRowRaw>()
  return {
    results: result.results.map((row) => ({
      cellId: row.cell_id,
      fileId: row.file_id,
      side: row.side,
      value: row.value,
      snippet: row.snippet,
      rank: row.rank,
      pairedValue: row.paired_value ?? null,
      ...locationFromRow(row),
    })),
    total: totalOf(result.results),
    totalIsLowerBound: false,
  }
}

// ---------------------------------------------------------------------------
// queryScopedPattern — match case / whole word / regexp
// ---------------------------------------------------------------------------

export interface PatternSearchOptions extends TextFindOptions {
  laneIds: SearchLaneWall
  side?: "source" | "target"
  limit?: number
  /** Restrict to one file. Omitted searches the project. */
  fileId?: string
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
  return (await queryScopedPatternPage(db, verifiedProjectId, q, opts)).results
}

/**
 * `queryScopedPattern`, with the number of cells that matched in all.
 *
 * The total is the count whenever it can be known:
 *   - match case alone is decided in SQL, so SQL's count is the answer;
 *   - whole word and regular expressions are decided here, in the worker, over
 *     the rows SQL let through. When that read took every such row, the cells
 *     the worker accepted are the count.
 * It is a floor (`totalIsLowerBound`) only when SQL let through more rows than
 * the read took: `MAX_LIMIT` of them for whole word or a regexp Postgres can
 * run, `PATTERN_SCAN_CAP` for one it cannot. The cells accepted so far all
 * match; whether the unread ones do is not known without reading them.
 */
export async function queryScopedPatternPage(
  db: AquillaDb,
  verifiedProjectId: VerifiedProjectId,
  q: string,
  opts: PatternSearchOptions,
): Promise<SearchPage<SearchResultOut>> {
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

  // One read of at most `rows` rows. `sqlFilter` says whether a regular
  // expression is tested in SQL; when it is not, every row is handed over and
  // tested below.
  const read = (sqlFilter: boolean, rows: number) => {
    const hit: string[] = [
      "SELECT",
      HIT_SELECT,
      HIT_TOTAL_SELECT,
      "FROM cells",
      "WHERE cells.project_id = ?",
      `AND ${notHiddenSql("cells")}`,
      `AND ${inCountedFileSql("cells")}`,
    ]
    const hitBinds: unknown[] = [verifiedProjectId]

    if (!find.useRegexp) {
      hit.push(
        find.matchCase
          ? "AND position(? in cells.value) > 0"
          : "AND position(lower(?) in lower(cells.value)) > 0",
      )
      hitBinds.push(q)
    } else if (sqlFilter) {
      hit.push(find.matchCase ? "AND cells.value ~ ?" : "AND cells.value ~* ?")
      hitBinds.push(q)
    }
    if (opts.side !== undefined) {
      hit.push("AND cells.side = ?")
      hitBinds.push(opts.side)
    }
    if (opts.fileId !== undefined) {
      hit.push("AND cells.file_id = ?")
      hitBinds.push(opts.fileId)
    }
    if (cellWall.sql) {
      hit.push(cellWall.sql)
      hitBinds.push(...cellWall.binds)
    }
    hit.push("ORDER BY cells.cell_id, cells.side", "LIMIT ?")
    hitBinds.push(rows)

    const { sql, binds } = pageStatement({
      hit,
      hitBinds,
      select: [
        "  cells.cell_id AS cell_id,",
        "  cells.file_id AS file_id,",
        "  cells.side AS side,",
        "  cells.value AS value,",
        "  hit.total_count AS total_count,",
        paired.sql,
      ],
      selectBinds: paired.binds,
      orderBy: "hit.cell_id, hit.side",
      placesByFile: numbersPlacesByFile(rows, opts.fileId),
      projectId: verifiedProjectId,
    })
    return db.prepare(sql).bind(...binds).all<PatternRowRaw>()
  }

  let result: { results: PatternRowRaw[] }
  try {
    result = await read(pgRegexp, fetchLimit)
  } catch (err) {
    // JS accepted the pattern and Postgres did not. Match in the worker
    // instead of failing the search.
    const message = err instanceof Error ? err.message : String(err)
    if (!pgRegexp || !/invalid regular expression/i.test(message)) throw err
    result = await read(false, PATTERN_SCAN_CAP)
  }
  const out: SearchResultOut[] = []
  // Every row read is tested, not only the first `limit` that pass: the ones
  // past the page are what the total is made of.
  let accepted = 0
  for (const row of result.results) {
    const hits = findTextMatches(row.value, q, find)
    if (hits.length === 0) continue
    accepted += 1
    if (out.length >= limit) continue
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
  }
  // Rows SQL admitted that this read did not take.
  const unread = Math.max(0, totalOf(result.results) - result.results.length)
  // A literal with no whole-word test is settled by the SQL filter, so every
  // unread row is a match too. Anything else is settled above, row by row.
  const sqlDecides = !find.useRegexp && !find.wholeWord
  return {
    results: out,
    total: sqlDecides ? accepted + unread : accepted,
    totalIsLowerBound: !sqlDecides && unread > 0,
  }
}

interface PatternRowRaw extends LocationRowRaw {
  cell_id: string
  file_id: string
  side: "source" | "target"
  value: string
  paired_value: string | null
}

interface TextRowRaw extends PatternRowRaw {
  /** Occurrences of the typed pieces. An integer, however the driver hands it over. */
  rank: number | string
}

// ---------------------------------------------------------------------------
// queryScopedText — default search for scripts the word index cannot serve
// ---------------------------------------------------------------------------

/**
 * Words a text search ANDs. A pasted sentence is the long case; past this
 * many words the rest add nothing the first sixteen have not already pinned.
 */
const MAX_TEXT_TERMS = 16

export interface TextSearchOptions {
  laneIds: SearchLaneWall
  side?: "source" | "target"
  limit?: number
  /** Restrict to one file. Omitted searches the project. */
  fileId?: string
  /** Match the whole query as one piece of text instead of word by word. */
  phrase?: boolean
}

/**
 * Chapter and verse of the reference a hit is shown under (`2KI 12:13`), as
 * numbers, so 4:10 sorts after 4:3 and 12:13 after both. The source row owns
 * the reference, as in LOCATION_SELECT. Null for a bare book code or no
 * reference at all.
 */
const HIT_REF_SQL = "COALESCE(loc.source_canonical_ref, NULLIF(BTRIM(cells.canonical_ref), ''))"
const REF_CHAPTER_SQL = String.raw`substring(${HIT_REF_SQL} from '(\d{1,6}):\d')::int`
const REF_VERSE_SQL = String.raw`substring(${HIT_REF_SQL} from '\d:(\d{1,6})')::int`

/** The pieces of `q` that must each be present. Order kept, repeats dropped. */
function textSearchTerms(q: string, phrase: boolean): string[] {
  const trimmed = q.trim()
  if (trimmed === "") return []
  if (phrase) return [trimmed]
  return [...new Set(trimmed.split(/\s+/))].slice(0, MAX_TEXT_TERMS)
}

/**
 * The default (no flags) search for a query `needsSubstringSearch` accepts:
 * Chinese, Japanese, Thai, Burmese, Korean and the rest of that list.
 *
 * It keeps the word search's contract, with "word" read as "what the person
 * typed between spaces": every such piece must be in the cell, in any order,
 * case-insensitively, but as text rather than as an indexed word, so 器皿
 * matches inside 一切銅器皿 and 하나님 matches 하나님이.
 *
 * Order is relevance, best first:
 *   1. cells holding the whole query exactly as typed (several words only);
 *   2. more occurrences of the typed pieces, summed;
 *   3. reading order: file, then place in the file. Most cells mention a
 *      term once, so this is what the list mostly looks like, and it is also
 *      what makes the order the same on every request.
 * `rank` in the result is (2), HIGHER is better, as `ts_rank` is for
 * `queryScopedSearch`.
 *
 * "Place in the file" is `sequence_index` where the importer wrote one, and
 * the chapter and verse of the cell's reference where it did not: a project
 * migrated from Codex has no `sequence_index` on any cell, and without the
 * second key its hits came back in cell-id order (2 Kings 4:3, 12:13, 4:4).
 * The editor's own order is the anchor chain, which SQL cannot sort by
 * without walking the file; these two agree with it except after a manual
 * move of a line.
 *
 * The project scope (`AND cells.project_id = ?`) is hardcoded, as in every
 * query in this module.
 */
export async function queryScopedText(
  db: AquillaDb,
  verifiedProjectId: VerifiedProjectId,
  q: string,
  opts: TextSearchOptions,
): Promise<SearchResultOut[]> {
  return (await queryScopedTextPage(db, verifiedProjectId, q, opts)).results
}

/** `queryScopedText`, with the number of cells that matched in all. */
export async function queryScopedTextPage(
  db: AquillaDb,
  verifiedProjectId: VerifiedProjectId,
  q: string,
  opts: TextSearchOptions,
): Promise<SearchPage<SearchResultOut>> {
  const terms = textSearchTerms(q, opts.phrase === true)
  if (terms.length === 0) return noMatches()

  const limit = clampLimit(opts.limit)
  const paired = pairedSubselect(opts.laneIds)
  const cellWall = wallFor("cells", opts.laneIds)
  const wholeFirst = terms.length > 1

  // Occurrences of one piece: how much shorter the text gets with the piece
  // cut out, over the piece's length. Two binds per piece.
  const occurrences =
    "(char_length(lower(cells.value)) - char_length(replace(lower(cells.value), lower(?), ''))) / char_length(lower(?))"

  const hit: string[] = [
    "SELECT",
    HIT_SELECT,
    `  (${terms.map(() => occurrences).join(" + ")}) AS rank,`,
    // Several words: does the cell hold the whole query as typed? The first
    // key of the order.
    ...(wholeFirst ? ["  (position(lower(?) in lower(cells.value)) > 0) AS whole,"] : []),
    HIT_TOTAL_SELECT,
    "FROM cells",
    "WHERE cells.project_id = ?",
    // AQU-1424 / AQU-1626, as in queryScopedSearch: parked cells, deleted
    // files and hidden companions are not searchable.
    `AND ${notHiddenSql("cells")}`,
    `AND ${inCountedFileSql("cells")}`,
  ]
  const hitBinds: unknown[] = [
    ...terms.flatMap((term) => [term, term]),
    ...(wholeFirst ? [q.trim()] : []),
    verifiedProjectId,
  ]

  for (const term of terms) {
    hit.push("AND position(lower(?) in lower(cells.value)) > 0")
    hitBinds.push(term)
  }
  if (opts.side !== undefined) {
    hit.push("AND cells.side = ?")
    hitBinds.push(opts.side)
  }
  if (opts.fileId !== undefined) {
    hit.push("AND cells.file_id = ?")
    hitBinds.push(opts.fileId)
  }
  if (cellWall.sql) {
    hit.push(cellWall.sql)
    hitBinds.push(...cellWall.binds)
  }

  // The order ends in where each hit sits in its file, and only the outer
  // query knows that. So `hit` cuts on the keys it does have and keeps every
  // row that ties with the last one it takes: whatever the full order then
  // puts on the page is among them. A tie is the hits of one file that
  // mention the term equally often, so it is one book's worth at most.
  const hitOrder = [...(wholeFirst ? ["whole DESC"] : []), "rank DESC", "cells.file_id"]
  hit.push(`ORDER BY ${hitOrder.join(", ")}`, "FETCH FIRST (?) ROWS WITH TIES")
  hitBinds.push(limit)

  const order = [
    ...(wholeFirst ? ["hit.whole DESC"] : []),
    "hit.rank DESC",
    "hit.file_id",
    "COALESCE(loc.source_sequence, 1e300)",
    `${REF_CHAPTER_SQL} NULLS LAST`,
    `${REF_VERSE_SQL} NULLS LAST`,
    "hit.cell_id",
    "hit.side",
  ]
  const { sql, binds } = pageStatement({
    hit,
    hitBinds,
    select: [
      "  cells.cell_id AS cell_id,",
      "  cells.file_id AS file_id,",
      "  cells.side AS side,",
      "  cells.value AS value,",
      "  hit.rank AS rank,",
      "  hit.total_count AS total_count,",
      paired.sql,
    ],
    selectBinds: paired.binds,
    orderBy: order.join(", "),
    limit,
    placesByFile: numbersPlacesByFile(limit, opts.fileId),
    projectId: verifiedProjectId,
  })

  const result = await db.prepare(sql).bind(...binds).all<TextRowRaw>()
  return {
    results: result.results.map((row) => {
      const hits: TextMatch[] = terms.flatMap((term) => findTextMatches(row.value, term))
      return {
        cellId: row.cell_id,
        fileId: row.file_id,
        side: row.side,
        value: row.value,
        snippet: markedSnippetOfAll(row.value, hits),
        rank: Number(row.rank),
        pairedValue: row.paired_value ?? null,
        ...locationFromRow(row),
      }
    }),
    total: totalOf(result.results),
    totalIsLowerBound: false,
  }
}

// ---------------------------------------------------------------------------
// queryScopedExact — ordered-phrase search with paired-side value
// ---------------------------------------------------------------------------

/**
 * Run an exact-phrase full-text search over `cells.value_tsv` for the given
 * project, and LEFT JOIN back to `cells` to fetch the opposite-side value at
 * the same (file_id, cell_id). Useful for the parallel-passages UI that
 * shows a source match next to its translation (or vice-versa).
 *
 * The project scope (`AND cells.project_id = ?`) is hardcoded — the caller
 * cannot bypass it.
 *
 * Throws on tsquery syntax errors. Returns [] when `exactText` sanitizes away.
 */
export async function queryScopedExact(
  db: AquillaDb,
  verifiedProjectId: VerifiedProjectId,
  exactText: string,
  opts: { side?: "source" | "target"; limit?: number; laneIds: SearchLaneWall },
): Promise<ParallelPassageRow[]> {
  return (await queryScopedExactPage(db, verifiedProjectId, exactText, opts)).results
}

/**
 * `queryScopedExact`, with the number of rows that matched in all. Rows, as
 * the list has them: the join below returns a source hit once per target lane
 * the caller can see, and the total counts it the same way.
 */
export async function queryScopedExactPage(
  db: AquillaDb,
  verifiedProjectId: VerifiedProjectId,
  exactText: string,
  opts: { side?: "source" | "target"; limit?: number; laneIds: SearchLaneWall },
): Promise<SearchPage<ParallelPassageRow>> {
  const ftsQuery = sanitizeFtsExactPhrase(exactText)
  if (!ftsQuery) return noMatches()

  // As in queryScopedSearch: the word index cannot answer these scripts. An
  // exact phrase is a literal substring anyway, so nothing is lost.
  if (needsSubstringSearch(exactText)) {
    return queryScopedTextPage(db, verifiedProjectId, exactText, {
      side: opts.side,
      limit: opts.limit,
      laneIds: opts.laneIds,
      phrase: true,
    })
  }

  const limit = clampLimit(opts.limit)
  const pairedWall = wallFor("paired", opts.laneIds)
  const cellWall = wallFor("cells", opts.laneIds)

  // The LEFT JOIN on `paired` fetches the opposite-side cell at the same
  // logical address. CASE flips source↔target so one query covers both
  // directions. `paired.value` is null when no paired row exists.
  // Postgres FTS: phraseto_tsquery requires the terms adjacent + in order
  // (matching the exact-phrase sanitizer's intent).
  const hit: string[] = [
    "SELECT",
    HIT_SELECT,
    // The pairing stays inside `hit`: it decides how many rows there are, so
    // the count and the LIMIT both have to see it. Only where the paired row
    // is leaves; null when there is none.
    "  paired.ctid AS paired_row_id,",
    "  ts_rank(cells.value_tsv, phraseto_tsquery('simple', ?)) AS rank,",
    HIT_TOTAL_SELECT,
    "FROM cells",
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
  const hitBinds: unknown[] = [exactText, ...pairedWall.binds, exactText, verifiedProjectId]

  if (opts.side !== undefined) {
    hit.push("AND cells.side = ?")
    hitBinds.push(opts.side)
  }
  if (cellWall.sql) {
    hit.push(cellWall.sql)
    hitBinds.push(...cellWall.binds)
  }
  hit.push("ORDER BY rank DESC", "LIMIT ?")
  hitBinds.push(limit)

  const { sql, binds } = pageStatement({
    hit,
    hitBinds,
    select: [
      "  cells.cell_id AS cell_id,",
      "  cells.file_id AS file_id,",
      "  cells.side AS side,",
      "  cells.value AS value,",
      "  ts_headline('simple', cells.value, phraseto_tsquery('simple', ?), 'StartSel=<mark>,StopSel=</mark>,MaxWords=16,MinWords=1,MaxFragments=1') AS snippet,",
      "  hit.rank AS rank,",
      "  hit.total_count AS total_count,",
      "  paired.value AS paired_value,",
    ],
    selectBinds: [exactText],
    joins: ["LEFT JOIN cells AS paired ON paired.ctid = hit.paired_row_id"],
    orderBy: "hit.rank DESC",
    placesByFile: numbersPlacesByFile(limit, undefined),
    projectId: verifiedProjectId,
  })

  const result = await db.prepare(sql).bind(...binds).all<ExactRowRaw>()
  return {
    results: result.results.map((row) => ({
      cellId: row.cell_id,
      fileId: row.file_id,
      side: row.side,
      value: row.value,
      snippet: row.snippet,
      rank: row.rank,
      pairedValue: row.paired_value,
      ...locationFromRow(row),
    })),
    total: totalOf(result.results),
    totalIsLowerBound: false,
  }
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
  /** ts_rank relevance over `cells.value_tsv` (HIGHER = better). */
  rank: number
}

/**
 * Retrieve up to `topK` validated cells whose SOURCE lexically overlaps
 * `queryText` (the asking cell's source), ranked by ts_rank, returning each
 * neighbor's validated TARGET.
 *
 * This is the one-hop example set for health-as-confidence, framed as a
 * counterfactual: "if the validated cells this source retrieves were your
 * few-shot examples, does your translation look like theirs?" Retrieval is by
 * source (the stable key for "what would I translate this from"); the caller
 * scores the asking cell's TARGET against these neighbors' TARGETS — so a
 * familiar source with a wrong translation scores low. Excludes `excludeCellId`
 * so a cell never endorses itself. SQL stays here (the project-scoped
 * full-text choke-point); scoring is the caller's pure function. Returns []
 * when the query sanitizes away.
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
