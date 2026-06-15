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
import { enqueueOutboxEvents } from "./outbox"

/** Cells per HTTP request. The worker turns each chunk into bounded multi-row
 *  Postgres inserts, keeping request bodies manageable while still amortizing
 *  Hyperdrive/network latency. */
const CHUNK = 1500
const IMPORT_ATTEMPTS = 3
const IMPORT_RETRY_DELAYS_MS = [200, 800] as const

function isRetryableImportStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

async function waitForImportRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Import cancelled")
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(new Error("Import cancelled"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export interface BulkImportCell {
  /** Client-minted event id (UUIDv7); becomes the cell's chain head. */
  id: string
  cellId: string
  anchorCellId: string | null
  value: string
  valueHtml?: string
  type?: string
  canonicalRef?: string
  /** Cue start/end in milliseconds (subtitle import). Persisted to the cells
   *  projection so VTT/character export survives reload. */
  startMs?: number
  endMs?: number
  // Timeline-segment-model (Scope A). Set at import; projected create-time.
  /** Intrinsic order key (fractional ranks allowed). */
  sequenceIndex?: number
  /** Primary content kind. Absent ⇒ 'text'. */
  medium?: "text" | "media"
  /** D1: true on the first cell of a paragraph block. Absent/false = continuation.
   *  Drives paragraph grouping for multi-cell draft operations. */
  paragraphStart?: boolean
  /** Extensible per-cell metadata bucket (e.g. `{ attachments: [...] }` for OBS
   *  frame images). Serialized verbatim into the chunk POST body below, which
   *  the server's `/import` route projects to the `cells.metadata` JSONB column.
   *  The `source.cell.create` event payload type already allows `metadata`. */
  metadata?: Record<string, unknown>
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
  sourceTextDirection?: "ltr" | "rtl"
  targetTextDirection?: "ltr" | "rtl"
  /** USFM book code (\id) — lets the server projection group/order by book. */
  bookCode?: string
  /** Timeline-segment-model order lens ('time' | 'sequence'). Stored in
   *  files.meta on the server; absent ⇒ client treats as 'sequence'. */
  orderedBy?: string
}

export interface BulkUploadArgs {
  projectId: string
  fileId: string
  file: BulkImportFileMeta
  cells: BulkImportCell[]
  /** Raw bytes of the source file for round-trip-fidelity formats (USFM
   *  today). Sent with the first chunk so the worker can stash it in
   *  `file_source_blobs` for export. */
  rawSource?: string
  rawSourceFormat?: string
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
  let token = await args.getToken(args.fileId)
  if (!token) {
    throw new Error(
      "Couldn't get an upload token — you may be signed out. Sign in and import again.",
    )
  }

  const url = `${syncWorkerHttpOrigin()}/import`
  const total = args.cells.length
  let uploaded = 0

  // Chunk offsets. `do…while` semantics: at least one request (carrying
  // file.create) even for a zero-cell file.
  const offsets: number[] = []
  for (let offset = 0; offset === 0 || offset < args.cells.length; offset += CHUNK) {
    offsets.push(offset)
  }

  const sendChunk = async (offset: number, isFirst: boolean): Promise<void> => {
    if (args.signal?.aborted) throw new Error("Import cancelled")
    const chunk = args.cells.slice(offset, offset + CHUNK)
    const payload: Record<string, unknown> = {
      projectId: args.projectId,
      fileId: args.fileId,
      cells: chunk,
      clientTs: Date.now(),
    }
    if (isFirst) {
      payload.file = args.file
      // Side-car raw bytes go alongside the first chunk so they land atomically
      // with the file.create. Subsequent chunks omit them.
      if (args.rawSource !== undefined && args.rawSourceFormat) {
        payload.rawSource = args.rawSource
        payload.rawSourceFormat = args.rawSourceFormat
      }
    }

    let lastError: Error | null = null
    for (let attempt = 0; attempt < IMPORT_ATTEMPTS; attempt++) {
      if (args.signal?.aborted) throw new Error("Import cancelled")
      let response: Response | null = null
      try {
        response = await fetchFn(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
          signal: args.signal,
        })
      } catch (err) {
        if (args.signal?.aborted) throw new Error("Import cancelled")
        const reason = err instanceof Error ? err.message : "network error"
        lastError = new Error(`Upload failed: ${reason}`)
      }

      if (response) {
        if (response.ok) {
          uploaded += chunk.length
          args.onProgress?.(uploaded, total)
          return
        }

        const detail = await response.text().catch(() => "")
        lastError = new Error(
          `Upload failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        )

        // Large imports can outlive their original file token. Refresh it and
        // retry the exact same idempotent chunk once the server returns 401.
        if (response.status === 401 && attempt < IMPORT_ATTEMPTS - 1) {
          const refreshed = await args.getToken(args.fileId)
          if (refreshed) {
            token = refreshed
            continue
          }
        }
        if (!isRetryableImportStatus(response.status)) throw lastError
      }

      if (attempt < IMPORT_ATTEMPTS - 1) {
        await waitForImportRetry(IMPORT_RETRY_DELAYS_MS[attempt], args.signal)
      }
    }

    throw lastError ?? new Error("Upload failed")
  }

  const finalize = async (): Promise<void> => {
    let lastError: Error | null = null

    for (let attempt = 0; attempt < IMPORT_ATTEMPTS; attempt++) {
      if (args.signal?.aborted) throw new Error("Import cancelled")
      let response: Response | null = null
      try {
        response = await fetchFn(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            projectId: args.projectId,
            fileId: args.fileId,
            cells: [],
            complete: true,
            clientTs: Date.now(),
          }),
          signal: args.signal,
        })
      } catch (err) {
        if (err instanceof Error && err.message === "Import cancelled") throw err
        lastError = err instanceof Error ? err : new Error(String(err))
      }

      if (response) {
        if (response.ok) return
        const detail = await response.text().catch(() => "")
        lastError = new Error(
          `Import finalization failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
        )

        // A long-running upload can outlive its original sync token. Refresh
        // once through the normal token provider before treating 401 as fatal.
        if (response.status === 401 && attempt < IMPORT_ATTEMPTS - 1) {
          const refreshed = await args.getToken(args.fileId)
          if (refreshed) {
            token = refreshed
            continue
          }
        }
        if (!isRetryableImportStatus(response.status)) throw lastError
      }

      if (attempt < IMPORT_ATTEMPTS - 1) {
        await waitForImportRetry(IMPORT_RETRY_DELAYS_MS[attempt], args.signal)
      }
    }

    throw lastError ?? new Error("Import finalization failed")
  }

  // The first chunk carries file.create (+ side-car raw source) and must land
  // before the rest so the file row exists. Send it alone.
  await sendChunk(offsets[0], true)

  // The remaining chunks are independent genesis source.cell.create batches:
  // the /import endpoint allocates each request's server_seq range atomically,
  // inserts are idempotent (INSERT OR IGNORE / upsert), cell display order is
  // encoded in anchorCellId/sequenceIndex (arrival-independent), and the file
  // counter recompute self-heals. So they can upload with bounded concurrency
  // to overlap network + DB latency — ~20 sequential round trips collapse to
  // ~5 waves on a Bible-sized import. A failed chunk rejects the whole upload;
  // re-running the import is safe (idempotent).
  const rest = offsets.slice(1)
  const POOL = 4
  let cursor = 0
  let uploadFailure: unknown | null = null
  const worker = async (): Promise<void> => {
    while (uploadFailure === null && cursor < rest.length) {
      const i = cursor++
      try {
        await sendChunk(rest[i], false)
      } catch (err) {
        // Stop assigning new chunks as soon as one fails. Requests already in
        // flight are allowed to settle before the partial state is finalized.
        uploadFailure ??= err
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(POOL, rest.length) }, () => worker()),
  )

  // Finalization is a required, idempotent part of the import now: it performs
  // the single authoritative counter/progress rebuild after all concurrent
  // chunks settle. It also runs after a partial failure so whatever did land
  // remains internally consistent and recoverable.
  try {
    await finalize()
  } catch (finalizeError) {
    if (uploadFailure !== null) {
      const uploadMessage = uploadFailure instanceof Error
        ? uploadFailure.message
        : String(uploadFailure)
      const finalizeMessage = finalizeError instanceof Error
        ? finalizeError.message
        : String(finalizeError)
      throw new Error(`${uploadMessage}; additionally, ${finalizeMessage}`)
    }
    throw finalizeError
  }

  if (uploadFailure !== null) throw uploadFailure
}

// ---------------------------------------------------------------------------
// Macula morph-row upload (AQU-178)
// ---------------------------------------------------------------------------

export interface MorphRow {
  cell_id: string
  word_seq: number
  surface: string
  lemma?: string
  morph_code?: string
  strongs_h?: string
  strongs_g?: string
}

export interface BulkMorphUploadArgs {
  projectId: string
  fileId: string
  rows: MorphRow[]
  getToken: (fileId: string) => Promise<string | null>
  onProgress?: (uploaded: number, total: number) => void
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

/** Rows per morph-upload chunk. Each row = 1 DB upsert, kept small for DB safety. */
const MORPH_CHUNK = 500

/**
 * Upload per-word morphology rows to the server's /import-morph endpoint.
 * Additive: re-importing the same file upserts rows (idempotent on the PK
 * `(project_id, file_id, cell_id, word_seq)`). Throws on the first failure.
 */
export async function bulkUploadMorphRows(args: BulkMorphUploadArgs): Promise<void> {
  if (args.rows.length === 0) return
  const fetchFn = args.fetchImpl ?? fetch
  const token = await args.getToken(args.fileId)
  if (!token) {
    throw new Error(
      "Couldn't get an upload token — you may be signed out. Sign in and import again.",
    )
  }

  const url = `${syncWorkerHttpOrigin()}/import-morph`
  const total = args.rows.length
  let uploaded = 0

  for (let offset = 0; offset < args.rows.length; offset += MORPH_CHUNK) {
    if (args.signal?.aborted) throw new Error("Import cancelled")
    const chunk = args.rows.slice(offset, offset + MORPH_CHUNK)
    const payload = { projectId: args.projectId, fileId: args.fileId, rows: chunk }

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
      throw new Error(`Morph upload failed: ${reason}`)
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      throw new Error(
        `Morph upload failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      )
    }

    uploaded += chunk.length
    args.onProgress?.(uploaded, total)
  }
}

export interface TargetCommit {
  /** Client-minted event id (UUIDv7). */
  id: string
  /** Cell to commit — must match the paired source cell's cellId. */
  cellId: string
  /** The paired source cell's event id — the AD-2 chain parent. A first
   *  target commit at a source's event id wins the target chain slot. */
  parentId: string
  value: string
}

export interface BulkTargetCommitArgs {
  projectId: string
  fileId: string
  /** Author stamped on the events (server overrides from the token). */
  author: string
  commits: TargetCommit[]
  getToken: (fileId: string) => Promise<string | null>
  onProgress?: (uploaded: number, total: number) => void
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

/**
 * Pre-fill target translations for a bilingual import by ENQUEUING one
 * target.cell.commit per cell to the outbox (not a direct POST). Used after
 * bulkUploadSource has seeded the paired source cells (the source event ids
 * become these commits' parentId).
 *
 * Enqueue is local + instant: the background flusher drains the events
 * (idempotent by deterministic id), the pending-overlay renders them
 * immediately, and the sync badge / inspector surface progress + retry +
 * dead-letter. This is why a large import now feels instant — content shows
 * before the network settles.
 *
 * NOTE: `getToken`, `signal`, and `fetchImpl` remain on the args type for
 * caller compatibility but are unused now — the flusher owns the network.
 */
export async function enqueueTargetCommits(args: BulkTargetCommitArgs): Promise<void> {
  if (args.commits.length === 0) return
  const events = args.commits.map((c) => ({
    id: c.id,
    schemaVersion: 1 as const,
    kind: "target.cell.commit" as const,
    projectId: args.projectId,
    fileId: args.fileId,
    cellId: c.cellId,
    parentId: c.parentId,
    author: args.author,
    payload: { value: c.value, sourceEventId: c.parentId },
    clientTs: Date.now(),
  }))
  await enqueueOutboxEvents(events as unknown as Parameters<typeof enqueueOutboxEvents>[0])
  args.onProgress?.(args.commits.length, args.commits.length)
}
