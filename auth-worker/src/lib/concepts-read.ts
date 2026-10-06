// A project's termbase, read the way the editor reads it (AQU-1715).
//
// Since 2026-09-04 a project's concepts live in the `concepts` table, the
// projection of `term.*` events (db/postgres/migrations/0084_concepts.sql).
// `migrateProjectConcepts` (sync-worker/src/events/migrate-concepts.ts) copies
// the old `project_settings.settings.terminology` array into that table and
// then deletes the key. A reader that still parses the key sees an empty
// termbase for every migrated project, and every term check built on it
// silently stops.
//
// This is the server-side twin of the editor's own read,
// GET /api/v1/projects/:id/concepts (sync-worker/src/events/concepts-read-route.ts),
// mapped onto the editor's `Concept` as src/lib/sync/concepts-read.ts maps it:
//
//   - the project's LIVE rows (deleted_at IS NULL), oldest first, every status;
//   - the legacy blob only when there are no live rows, decoded by the editor's
//     own decoder (readBlobConcepts), so a leftover blob never adds to the table.
//
// Database errors propagate. The caller decides whether a failed read is a 500
// or a warning, so an empty result only ever means an empty termbase.
//
// Every server reader of a termbase that applies its terms goes through here:
// the subscription route (routes/termbase-subscriptions.ts) and autopilot's own
// and subscribed concepts (lib/contextual/project-context.ts). They cannot read
// different termbases.

import { coerceMatchOptions } from "../../../src/lib/terminology/match-options"
import type { TermMatchOptions, TermRendering } from "../../../src/lib/terminology/model"
import { readBlobConcepts } from "../../../sync-worker/src/events/migrate-concepts"

/** Mirrors `Concept` in src/lib/terminology/types.ts, which cannot be imported
 *  here (it pulls in the SPA's i18n catalog). */
export interface StoredConcept {
  id: string
  sourceTerm: string
  renderings: TermRendering[]
  notes?: string
  status: "active" | "draft" | "deprecated"
  createdAt: string
  createdBy?: string
  updatedAt?: string
  caseSensitive?: boolean
  match?: TermMatchOptions
}

export interface ConceptsDb {
  prepare(query: string): {
    bind(...params: unknown[]): {
      first<T>(): Promise<T | null>
      all<T>(): Promise<{ results: T[] }>
    }
  }
}

/** One concept in the editor read route's wire shape (`ConceptRowOut`).
 *  Table rows and readBlobConcepts' output both arrive in it. */
interface WireConcept {
  conceptId: string
  sourceTerm: string
  renderings: unknown
  notes: string | null
  status: StoredConcept["status"]
  caseSensitive: boolean
  matchOptions?: TermMatchOptions
  createdBy: string | null
  createdAt: number
  updatedAt: number
}

interface ConceptRow {
  concept_id: string
  source_term: string
  renderings: unknown
  notes: string | null
  status: string
  case_sensitive: number
  match_options: unknown
  created_by: string | null
  created_at: number
  updated_at: number
}

const RENDERING_STATUSES: readonly unknown[] = ["preferred", "admitted", "forbidden"]

/** A JSONB column can arrive parsed or as text, depending on the driver. */
function jsonColumn(raw: unknown): unknown {
  if (typeof raw !== "string") return raw
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

/** Renderings, filtered as the editor's read route filters them. */
function renderingsOf(raw: unknown): TermRendering[] {
  const value = jsonColumn(raw)
  if (!Array.isArray(value)) return []
  return value.filter(
    (r): r is TermRendering =>
      typeof r === "object" &&
      r !== null &&
      typeof (r as { rendering?: unknown }).rendering === "string" &&
      RENDERING_STATUSES.includes((r as { status?: unknown }).status),
  )
}

/** A table row in the wire shape, as the editor's read route builds it. */
function rowToWire(row: ConceptRow): WireConcept {
  const matchOptions = coerceMatchOptions(jsonColumn(row.match_options))
  return {
    conceptId: row.concept_id,
    sourceTerm: row.source_term,
    renderings: row.renderings,
    notes: row.notes,
    status: row.status === "active" || row.status === "deprecated" ? row.status : "draft",
    caseSensitive: row.case_sensitive === 1,
    ...(matchOptions ? { matchOptions } : {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Wire shape → the editor's `Concept`, as src/lib/sync/concepts-read.ts maps it. */
function toConcept(wire: WireConcept): StoredConcept {
  return {
    id: wire.conceptId,
    sourceTerm: wire.sourceTerm,
    renderings: renderingsOf(wire.renderings),
    status: wire.status,
    createdAt: new Date(wire.createdAt).toISOString(),
    updatedAt: new Date(wire.updatedAt).toISOString(),
    ...(wire.notes != null ? { notes: wire.notes } : {}),
    ...(wire.createdBy != null ? { createdBy: wire.createdBy } : {}),
    ...(wire.caseSensitive ? { caseSensitive: true } : {}),
    ...(wire.matchOptions ? { match: wire.matchOptions } : {}),
  }
}

/**
 * Every live concept of `projectId`, in every status, as the editor reads it.
 * Callers that enforce terms keep `status === "active"` themselves.
 */
export async function readProjectConcepts(db: ConceptsDb, projectId: string): Promise<StoredConcept[]> {
  const { results } = await db
    .prepare(
      `SELECT concept_id, source_term, renderings, notes, status, case_sensitive,
              match_options, created_by, created_at, updated_at
         FROM concepts
        WHERE project_id = ? AND deleted_at IS NULL
        ORDER BY created_at ASC`,
    )
    .bind(projectId)
    .all<ConceptRow>()
  const wire: WireConcept[] =
    results.length > 0 ? results.map(rowToWire) : await readBlobConcepts(db, projectId)
  return wire.map(toConcept)
}
