// AQU-1192: one concept's occurrences, read from the cells projection.
//
// The detail page used to download every file's cells and filter them in the
// browser. Full-text search cannot stand in for that filter: the terminology
// matcher allows inflection wildcards, combining-mark folding, and project
// affixes, and a `simple` tsquery drops those hits. This scan confirms each
// source row with that same matcher, then returns one page of confirmed hits
// plus an exact count when the scan finishes.

import { buildConceptRegex, stripMarks } from "../../../src/lib/terminology/match"
import { coerceMatchOptions, resolveMatchOptions } from "../../../src/lib/terminology/match-options"
import type { ConceptMatchInput, TermMatchingSettings, TermRendering } from "../../../src/lib/terminology/model"
import type { TermFormTally, TermOccurrencePage, TermOccurrenceWire } from "../../../src/lib/terminology/occurrence-page"
import { verdictForKnownMatch } from "../../../src/lib/terminology/verdict"
import { targetLaneDualReadBinds, targetLaneDualReadSql } from "./lane-id-sql"
import { visibleSourceSql } from "./hidden-cells-scope"
import { inCountedFileSql } from "../../../db/shared/counted-files"

/** Stop a pathological project from holding the request open. */
const MAX_SCAN = 50_000
/**
 * Read the scan cap in one query. A small LIMIT still sorts and joins the
 * whole project, so paging that SQL once per 400 rows repeated a ~400ms join
 * and a Bible-sized project took about half a minute.
 */
const BATCH = MAX_SCAN
/** Sorts with NULL sequence_index, which ORDER BY treats as last. */
const NULL_SEQUENCE = 1e300

interface ConceptRow {
  source_term: string
  renderings: unknown
  case_sensitive: number
  match_options: unknown
}

interface SourceRow {
  file_id: string
  cell_id: string
  original: string
  canonical_ref: string | null
  source_event_id: string
  sequence_index: number | null
  translated: string | null
  translated_html: string | null
  target_event_id: string | null
}

interface Cursor {
  fileId: string
  sequence: number
  cellId: string
}

function parseRenderings(raw: unknown): TermRendering[] {
  let list = raw
  if (typeof list === "string") {
    try {
      list = JSON.parse(list)
    } catch {
      return []
    }
  }
  if (!Array.isArray(list)) return []
  const out: TermRendering[] = []
  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const rendering = (item as { rendering?: unknown }).rendering
    const status = (item as { status?: unknown }).status
    if (typeof rendering !== "string" || !rendering.trim()) continue
    if (status !== "preferred" && status !== "admitted" && status !== "forbidden") continue
    out.push({ rendering, status })
  }
  return out
}

function parseSettings(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>
  return null
}

function parseTermMatching(raw: unknown): TermMatchingSettings | undefined {
  const settings = parseSettings(raw)
  const tm = settings?.termMatching
  if (!tm || typeof tm !== "object" || Array.isArray(tm)) return undefined
  const rec = tm as Record<string, unknown>
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : []
  const maxAffixes = typeof rec.maxAffixes === "number" && Number.isFinite(rec.maxAffixes) ? rec.maxAffixes : undefined
  const foldMarksDefault = typeof rec.foldMarksDefault === "boolean" ? rec.foldMarksDefault : undefined
  return {
    prefixes: strings(rec.prefixes),
    suffixes: strings(rec.suffixes),
    ...(maxAffixes !== undefined ? { maxAffixes } : {}),
    ...(foldMarksDefault !== undefined ? { foldMarksDefault } : {}),
  }
}

/**
 * A row's matcher input. `renderings` is always parsed (an empty list when the
 * column is null or malformed), so callers that build a full `Concept` — whose
 * renderings are required — can rely on it.
 */
export type RowConceptMatch = ConceptMatchInput & { renderings: TermRendering[] }

export function conceptMatchFromRow(row: {
  source_term: string
  renderings: unknown
  case_sensitive: number | boolean
  match_options: unknown
}): RowConceptMatch {
  return toConcept({
    source_term: row.source_term,
    renderings: row.renderings,
    case_sensitive: row.case_sensitive ? 1 : 0,
    match_options: row.match_options,
  })
}

function toConcept(row: ConceptRow): RowConceptMatch {
  const match = coerceMatchOptions(typeof row.match_options === "string" ? safeParse(row.match_options) : row.match_options)
  return {
    sourceTerm: row.source_term,
    renderings: parseRenderings(row.renderings),
    ...(row.case_sensitive ? { caseSensitive: true } : {}),
    ...(match ? { match } : {}),
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

async function fetchBatch(
  db: AquillaDb,
  projectId: string,
  lane: string,
  cursor: Cursor | null,
  limit: number,
): Promise<SourceRow[]> {
  const cursorSql = cursor
    ? "AND (s.file_id, COALESCE(s.sequence_index, 1e300), s.cell_id) > (?, ?, ?)"
    : ""
  const sql = [
    "SELECT s.file_id, s.cell_id, s.value AS original, s.canonical_ref,",
    "s.event_id AS source_event_id, s.sequence_index,",
    "t.value AS translated, t.value_html AS translated_html, t.event_id AS target_event_id",
    "FROM cells s",
    "LEFT JOIN cells t",
    "  ON t.project_id = s.project_id AND t.file_id = s.file_id AND t.cell_id = s.cell_id",
    " AND t.side = 'target'",
    ` AND ${targetLaneDualReadSql("t")}`,
    "WHERE s.project_id = ? AND s.side = 'source'",
    ` AND ${visibleSourceSql("s")}`,
    // AQU-1626: an occurrence inside a deleted file or a hidden companion is
    // not an occurrence a translator can act on — the file is not openable from
    // the sidebar, so the row was a dead end in the term drawer.
    ` AND ${inCountedFileSql("s")}`,
    " AND s.tombstoned_at IS NULL AND s.value <> ''",
    cursorSql,
    "ORDER BY s.file_id, COALESCE(s.sequence_index, 1e300), s.cell_id",
    "LIMIT ?",
  ].join(" ")
  const binds: unknown[] = [
    ...targetLaneDualReadBinds(projectId, lane),
    projectId,
    ...(cursor ? [cursor.fileId, cursor.sequence, cursor.cellId] : []),
    limit,
  ]
  const result = await db.prepare(sql).bind(...binds).all<SourceRow>()
  return result.results
}

function toWire(row: SourceRow, translated: string): TermOccurrenceWire {
  return {
    cellId: row.cell_id,
    fileId: row.file_id,
    original: row.original,
    translated,
    translatedHtml: row.translated_html,
    context: row.canonical_ref ?? "",
    sourceEventId: row.source_event_id,
    targetEventId: row.target_event_id,
  }
}

/**
 * Confirmed occurrences of one concept. `offset`/`limit` page the confirmed
 * hits; the scan still walks the project's source rows so `total` is exact
 * whenever `scanComplete` is true.
 */
export async function queryConceptOccurrences(
  db: AquillaDb,
  projectId: string,
  concept: ConceptMatchInput,
  termMatching: TermMatchingSettings | undefined,
  opts: { offset: number; limit: number; lane?: string },
): Promise<TermOccurrencePage> {
  const lane = opts.lane ?? ""
  const occurrences: TermOccurrenceWire[] = []
  const forms = new Map<string, TermFormTally>()
  const resolved = resolveMatchOptions(concept, termMatching)
  const caseSensitive = concept.caseSensitive === true
  const excludedKeys = new Set(
    resolved.excludedForms.map((form) => formKey(form, resolved.foldMarks, caseSensitive)),
  )
  // One compiled pattern for the whole scan. Rebuilding it per cell is what
  // made a Bible-sized project take tens of seconds.
  const matcher = buildConceptRegex(concept, termMatching, caseSensitive ? "gu" : "giu", {
    includeExcluded: true,
  })
  let total = 0
  let enforced = 0
  let infringed = 0
  let scanned = 0
  let scanComplete = true
  let cursor: Cursor | null = null

  while (scanned < MAX_SCAN) {
    const remaining = Math.min(BATCH, MAX_SCAN - scanned)
    const rows = await fetchBatch(db, projectId, lane, cursor, remaining)
    if (rows.length === 0) break
    for (const row of rows) {
      scanned += 1
      const translated = row.translated ?? ""
      const hits = surfacesIn(matcher, row.original)
      if (hits.length === 0) continue
      let live = false
      for (const hit of hits) {
        const surface = hit.normalize("NFC")
        const excluded = excludedKeys.has(formKey(surface, resolved.foldMarks, caseSensitive))
        const existing = forms.get(surface)
        if (existing) existing.count += 1
        else forms.set(surface, { surface, count: 1, excluded })
        if (!excluded) live = true
      }
      if (!live) continue
      const verdict = verdictForKnownMatch(concept, translated)
      if (verdict === "enforced") enforced += 1
      else infringed += 1
      total += 1
      if (total > opts.offset && occurrences.length < opts.limit) {
        occurrences.push(toWire(row, translated))
      }
    }
    const last = rows[rows.length - 1]
    cursor = {
      fileId: last.file_id,
      sequence: last.sequence_index == null ? NULL_SEQUENCE : Number(last.sequence_index),
      cellId: last.cell_id,
    }
    if (rows.length < remaining) break
    if (scanned >= MAX_SCAN) {
      scanComplete = false
      break
    }
  }

  return {
    occurrences,
    total,
    offset: opts.offset,
    limit: opts.limit,
    scanComplete,
    enforced,
    infringed,
    forms: [...forms.values()].sort((a, b) => b.count - a.count || a.surface.localeCompare(b.surface)),
  }
}

function surfacesIn(matcher: RegExp | null, haystack: string): string[] {
  if (!matcher || !haystack) return []
  matcher.lastIndex = 0
  const surfaces: string[] = []
  let match: RegExpExecArray | null
  while ((match = matcher.exec(haystack)) !== null) {
    if (match[0].length === 0) {
      matcher.lastIndex += 1
      continue
    }
    surfaces.push(match[0])
  }
  return surfaces
}

function formKey(surface: string, foldMarks: boolean, caseSensitive: boolean): string {
  const folded = foldMarks ? stripMarks(surface) : surface.normalize("NFC")
  return caseSensitive ? folded : folded.toLowerCase()
}

/** Source rows paired with the default-lane target, one query up to the scan cap. */
export async function loadVisibleSourceTargets(
  db: AquillaDb,
  projectId: string,
  lane = "",
): Promise<{ pairs: VisiblePair[]; scanComplete: boolean }> {
  const rows = await fetchBatch(db, projectId, lane, null, MAX_SCAN)
  return {
    pairs: rows.map((row) => ({
      fileId: row.file_id,
      cellId: row.cell_id,
      original: row.original,
      translated: row.translated ?? "",
      context: row.canonical_ref ?? "",
    })),
    scanComplete: rows.length < MAX_SCAN,
  }
}

/** Source text only. Suggest-terms mining does not need the target join. */
export async function loadVisibleSourceTexts(
  db: AquillaDb,
  projectId: string,
): Promise<{ texts: string[]; scanComplete: boolean }> {
  const result = await db
    .prepare(
      [
        "SELECT s.value AS original",
        "FROM cells s",
        "WHERE s.project_id = ? AND s.side = 'source'",
        ` AND ${visibleSourceSql("s")}`,
        // AQU-1626: and mining skips them too, or a dubbed project's suggested
        // terminology comes back full of timecodes.
        ` AND ${inCountedFileSql("s")}`,
        " AND s.tombstoned_at IS NULL AND s.value <> ''",
        "ORDER BY s.file_id, COALESCE(s.sequence_index, 1e300), s.cell_id",
        "LIMIT ?",
      ].join(" "),
    )
    .bind(projectId, MAX_SCAN)
    .all<{ original: string }>()
  const texts = result.results.map((row) => row.original)
  return { texts, scanComplete: texts.length < MAX_SCAN }
}

export async function loadProjectTermMatching(
  db: AquillaDb,
  projectId: string,
): Promise<TermMatchingSettings | undefined> {
  const settings = await db
    .prepare("SELECT settings FROM project_settings WHERE project_id = ?")
    .bind(projectId)
    .first<{ settings: unknown }>()
  return parseTermMatching(settings?.settings)
}

export interface VisiblePair {
  fileId: string
  cellId: string
  original: string
  translated: string
  context: string
}

export async function loadConceptForOccurrences(
  db: AquillaDb,
  projectId: string,
  conceptId: string,
): Promise<{ concept: ConceptMatchInput; termMatching: TermMatchingSettings | undefined } | null> {
  const row = await db
    .prepare(
      `SELECT source_term, renderings, case_sensitive, match_options
       FROM concepts
       WHERE project_id = ? AND concept_id = ? AND deleted_at IS NULL`,
    )
    .bind(projectId, conceptId)
    .first<ConceptRow>()
  if (!row) return null
  const settings = await db
    .prepare("SELECT settings FROM project_settings WHERE project_id = ?")
    .bind(projectId)
    .first<{ settings: unknown }>()
  return {
    concept: toConcept(row),
    termMatching: parseTermMatching(settings?.settings),
  }
}
