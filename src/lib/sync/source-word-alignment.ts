// Typed client for Bridge 1's stored links (AQU-1694).
//
//   GET  /api/v1/projects/:projectId/files/:fileId/source-word-alignment
//   POST /api/v1/projects/:projectId/files/:fileId/source-word-alignment
//
// See sync-worker/src/events/source-word-alignment-route.ts. A write is sent
// in chunks the route accepts; the first chunk starts a new run for the file.

import type { SourceBookAlignment } from "@/lib/bible-data/source-alignment"
import { syncWorkerHttpOrigin } from "./sync-worker-url"
import { timeoutSignal } from "./fetch-timeout"

/** [pack word id, source token index, confidence]. */
export type StoredLink = [string, number, number]

/** One aligned source cell as the route returns it. */
export interface StoredAlignmentCell {
  cellId: string
  sourceHash: string
  method: string
  trainedPairs: number
  /** The source text changed since this cell was aligned; `links` is empty. */
  stale: boolean
  links: StoredLink[]
}

export class SourceAlignmentRequestError extends Error {
  status: number
  constructor(status: number, body: string) {
    super(`source word alignment request failed: HTTP ${status}${body ? ` — ${body.slice(0, 200)}` : ""}`)
    this.status = status
    this.name = "SourceAlignmentRequestError"
  }
}

const READ_TIMEOUT_MS = 20_000
const WRITE_TIMEOUT_MS = 30_000
/** Under the route's caps (400 cells, 12,000 links per request). */
const CHUNK_CELLS = 300
const CHUNK_LINKS = 10_000

function routeUrl(projectId: string, fileId: string): string {
  return (
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/files/${encodeURIComponent(fileId)}/source-word-alignment`
  )
}

export async function fetchSourceWordAlignment(args: {
  projectId: string
  fileId: string
  jwt: string
  signal?: AbortSignal
}): Promise<StoredAlignmentCell[]> {
  const response = await fetch(routeUrl(args.projectId, args.fileId), {
    headers: { Authorization: `Bearer ${args.jwt}` },
    signal: args.signal ?? timeoutSignal(READ_TIMEOUT_MS),
  })
  if (!response.ok) throw new SourceAlignmentRequestError(response.status, await response.text().catch(() => ""))
  const body = (await response.json()) as { cells?: StoredAlignmentCell[] }
  return body.cells ?? []
}

/** Split a book's cells into requests the route accepts. */
export function chunkAlignment(alignment: SourceBookAlignment): SourceBookAlignment["cells"][] {
  const chunks: SourceBookAlignment["cells"][] = []
  let current: SourceBookAlignment["cells"] = []
  let links = 0
  for (const cell of alignment.cells) {
    if (current.length > 0 && (current.length >= CHUNK_CELLS || links + cell.links.length > CHUNK_LINKS)) {
      chunks.push(current)
      current = []
      links = 0
    }
    current.push(cell)
    links += cell.links.length
  }
  // An empty book still sends one chunk, so the run clears the file's old rows.
  chunks.push(current)
  return chunks
}

/**
 * Store a book's alignment. Returns the cells the server refused because
 * their source text changed while the browser aligned it.
 */
export async function uploadSourceWordAlignment(args: {
  projectId: string
  fileId: string
  jwt: string
  method: string
  alignment: SourceBookAlignment
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}): Promise<{ stale: string[] }> {
  const chunks = chunkAlignment(args.alignment)
  const stale: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    if (args.signal?.aborted) throw new DOMException("alignment cancelled", "AbortError")
    const body = {
      replace: i === 0 ? "file" : "cells",
      method: args.method,
      trainedPairs: args.alignment.trainedPairs,
      cells: chunks[i].map((cell) => ({
        cellId: cell.cellId,
        sourceHash: cell.sourceHash,
        // Floor, never round: 0.4996 must not become a solid 0.5.
        links: cell.links.map((link) => [link.wordId, link.token, Math.floor(link.conf * 1000) / 1000]),
      })),
    }
    const response = await fetch(routeUrl(args.projectId, args.fileId), {
      method: "POST",
      headers: { Authorization: `Bearer ${args.jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: args.signal ?? timeoutSignal(WRITE_TIMEOUT_MS),
    })
    if (!response.ok) throw new SourceAlignmentRequestError(response.status, await response.text().catch(() => ""))
    const result = (await response.json()) as { stale?: string[] }
    stale.push(...(result.stale ?? []))
    args.onProgress?.(i + 1, chunks.length)
  }
  return { stale }
}
