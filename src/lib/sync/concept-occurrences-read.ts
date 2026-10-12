// GET /api/v1/projects/:projectId/concepts/:conceptId/occurrences (AQU-1192)
//
// One page of cells the concept matcher accepts. The term detail page uses
// this instead of downloading every file in the project.

import type { CellData } from "@/hooks/useCells"
import { parseTermOccurrencePage, type TermOccurrencePage } from "@/lib/terminology/occurrence-page"
import { syncWorkerHttpOrigin } from "./sync-worker-url"

export class ConceptOccurrencesError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`concept occurrences failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = "ConceptOccurrencesError"
  }
}

export interface FetchConceptOccurrencesOpts {
  offset?: number
  limit?: number
  lane?: string
  signal?: AbortSignal
}

export async function fetchConceptOccurrences(
  projectId: string,
  conceptId: string,
  jwt: string,
  options: FetchConceptOccurrencesOpts = {},
): Promise<TermOccurrencePage> {
  const params = new URLSearchParams()
  if (options.offset) params.set("offset", String(options.offset))
  if (options.limit) params.set("limit", String(options.limit))
  if (options.lane !== undefined) params.set("lane", options.lane)
  const qs = params.toString()
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/concepts/${encodeURIComponent(conceptId)}/occurrences` +
    (qs ? `?${qs}` : "")
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${jwt}` },
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new ConceptOccurrencesError(res.status, body)
  }
  const page = parseTermOccurrencePage(await res.json())
  if (!page) throw new ConceptOccurrencesError(res.status, "unexpected occurrence payload")
  return page
}

/** Projection row → the cell shape the detail page already edits. */
export function occurrenceToCell(row: TermOccurrencePage["occurrences"][number]): CellData {
  return {
    id: row.cellId,
    fileId: row.fileId,
    original: row.original,
    translated: row.translated,
    ...(row.translatedHtml ? { translatedHtml: row.translatedHtml } : {}),
    context: row.context,
    group: "",
    type: "text",
    status: row.translated.trim() ? "unvalidated" : "empty",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    sourceEventId: row.sourceEventId,
    ...(row.targetEventId ? { targetEventId: row.targetEventId } : {}),
  }
}
