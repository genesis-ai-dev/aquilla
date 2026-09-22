// Typed fetch wrapper for the sync-worker terminology concepts read API.
// (AQU-1006 follow-up)
//
// Pattern follows comments-read.ts.
//
// The wire shape (`ConceptRowOut`, snake-cased columns mapped to camelCase by
// the route) is mapped here onto the `Concept` type the whole terminology
// pipeline already speaks — compile.ts, glossary-view.ts, stats.ts, the CSV and
// TBX importers, and every terminology component. Nothing downstream of this
// function needs to know terminology moved off the settings blob.

import { syncWorkerHttpOrigin } from './sync-worker-url'
import type { Concept, TermRendering, TermMatchOptions } from '@/lib/terminology/types'

export class ConceptsReadError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`concepts-read failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = 'ConceptsReadError'
  }
}

interface ConceptRowWire {
  conceptId: string
  projectId: string
  sourceTerm: string
  renderings: TermRendering[]
  notes: string | null
  status: 'active' | 'draft' | 'deprecated'
  caseSensitive: boolean
  matchOptions: TermMatchOptions | null
  createdBy: string | null
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}

/**
 * Wire row → `Concept`.
 *
 * Timestamps cross as epoch millis (the events table's native unit) and become
 * ISO strings, because `Concept.createdAt` is an ISO string everywhere else —
 * the CSV/TBX exporters and the review queue's sort both read it as one.
 * Optional keys are OMITTED rather than set to null/undefined: `Concept` marks
 * them optional, and the equality checks in the settings layer treat a present
 * `undefined` as a different value from an absent key.
 */
function toConcept(row: ConceptRowWire): Concept {
  return {
    id: row.conceptId,
    sourceTerm: row.sourceTerm,
    renderings: row.renderings ?? [],
    status: row.status,
    createdAt: new Date(row.createdAt).toISOString(),
    ...(row.notes != null ? { notes: row.notes } : {}),
    ...(row.createdBy != null ? { createdBy: row.createdBy } : {}),
    ...(row.updatedAt != null ? { updatedAt: new Date(row.updatedAt).toISOString() } : {}),
    ...(row.caseSensitive ? { caseSensitive: true } : {}),
    ...(row.matchOptions ? { match: row.matchOptions } : {}),
  }
}

/**
 * GET /api/v1/projects/:projectId/concepts
 *
 * Every live concept for the project, ordered createdAt ASC. Tombstoned rows
 * are excluded unless `includeDeleted` is set (audit surfaces only).
 */
export async function fetchConcepts(
  projectId: string,
  jwt: string,
  options?: { includeDeleted?: boolean; signal?: AbortSignal },
): Promise<Concept[]> {
  const params = new URLSearchParams()
  if (options?.includeDeleted) params.set('includeDeleted', '1')
  const qs = params.toString()
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/concepts` +
    (qs ? `?${qs}` : '')

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${jwt}` },
    ...(options?.signal ? { signal: options.signal } : {}),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ConceptsReadError(res.status, body)
  }
  const json = (await res.json()) as { concepts?: ConceptRowWire[] }
  return (json.concepts ?? []).map(toConcept)
}
