// Fast source-import upload path (pairs with apps/sync `POST /import`).
//
// A fresh source file (eBible = ~31k cells, USFM books, DOCX, …) is a genesis
// import: one file.create plus N chained source.cell.create events. Rather than
// dripping them through the outbox at 100-per-5s (minutes, and silent on
// failure), we stream them straight to the server's bulk endpoint in large
// chunks with visible progress. The endpoint writes events + projection rows in
// one shot per chunk (no per-event round trip), and is idempotent (INSERT OR
// IGNORE / upsert), so a failed chunk can be retried by re-running the import.
//
// The outbox remains the path for incremental edits (target commits,
// validations); only the initial bulk source load uses this.

import { syncWorkerHttpOrigin } from "./sync-worker-url"

/** Cells per HTTP request. Each cell = 2 D1 statements server-side; the worker
 *  batches them ≤100/batch, so 1500 cells ≈ 30 D1 batches per request — well
 *  under Workers' subrequest ceiling, with smooth progress. */
const CHUNK = 1500

export interface BulkImportCell {
  /** Client-minted event id (UUIDv7); becomes the cell's chain head. */
  id: string
  cellId: string
  anchorCellId: string | null
  value: string
  valueHtml?: string
  type?: string
  canonicalRef?: string
}

export interface BulkImportFileMeta {
  /** file.create event id (UUIDv7). */
  id: string
  name: string
  fileType?: string
  role?: string
  kind?: string
  importFormat?: string
  parserVersion?: string
  sourceLanguage?: string
  targetLanguage?: string
}

export interface BulkUploadArgs {
  projectId: string
  fileId: string
  file: BulkImportFileMeta
  cells: BulkImportCell[]
  /** Mints a sync-token scoped to (projectId, fileId). */
  getToken: (fileId: string) => Promise<string | null>
  /** Fired after each chunk lands — drives the progress UI. */
  onProgress?: (uploaded: number, total: number) => void
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

/**
 * Upload a parsed source file to the server in chunks. Resolves once every
 * cell has landed; throws (with a human-readable message) on the first failure
 * so the dialog can surface it instead of silently parking work.
 */
export async function bulkUploadSource(args: BulkUploadArgs): Promise<void> {
  const fetchFn = args.fetchImpl ?? fetch
  const token = await args.getToken(args.fileId)
  if (!token) {
    throw new Error(
      "Couldn't get an upload token — you may be signed out. Sign in and import again.",
    )
  }

  const url = `${syncWorkerHttpOrigin()}/import`
  const total = args.cells.length
  let uploaded = 0
  let first = true

  // `do…while` guarantees at least one request (carrying file.create) even for
  // a zero-cell file.
  let offset = 0
  do {
    if (args.signal?.aborted) throw new Error("Import cancelled")
    const chunk = args.cells.slice(offset, offset + CHUNK)
    const payload: Record<string, unknown> = {
      projectId: args.projectId,
      fileId: args.fileId,
      cells: chunk,
      clientTs: Date.now(),
    }
    if (first) payload.file = args.file

    let res: Response
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
        signal: args.signal,
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : "network error"
      throw new Error(`Upload failed: ${reason}`)
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      throw new Error(
        `Upload failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      )
    }

    uploaded += chunk.length
    args.onProgress?.(uploaded, total)
    first = false
    offset += CHUNK
  } while (offset < args.cells.length)
}
