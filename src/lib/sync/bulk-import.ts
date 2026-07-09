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
  const token = await args.getToken(args.fileId)
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
  const worker = async (): Promise<void> => {
    while (cursor < rest.length) {
      const i = cursor++
      await sendChunk(rest[i], false)
    }
  }
  await Promise.all(Array.from({ length: Math.min(POOL, rest.length) }, () => worker()))
}

// ---------------------------------------------------------------------------
// Macula morph-row upload (FRO-178)
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

/** Commits per chunk for target.cell.commit. Smaller than source CHUNK: the
 *  /events route does per-event AD-2 guards (heavier than /import's fast path). */
const TARGET_CHUNK = 200

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
 * Pre-fill target translations for a bilingual import: emit one
 * target.cell.commit per cell through the regular /events route, in chunks.
 * Used after bulkUploadSource has seeded the paired source cells (the source
 * event ids become these commits' parentId). Throws on the first failure.
 */
export async function bulkUploadTargetCommits(args: BulkTargetCommitArgs): Promise<void> {
  const fetchFn = args.fetchImpl ?? fetch
  if (args.commits.length === 0) return
  const token = await args.getToken(args.fileId)
  if (!token) {
    throw new Error("Couldn't get an upload token — you may be signed out. Sign in and import again.")
  }
  const url = `${syncWorkerHttpOrigin()}/events`
  const total = args.commits.length
  let uploaded = 0

  for (let offset = 0; offset < args.commits.length; offset += TARGET_CHUNK) {
    if (args.signal?.aborted) throw new Error("Import cancelled")
    const chunk = args.commits.slice(offset, offset + TARGET_CHUNK)
    const events = chunk.map((c) => ({
      id: c.id,
      schemaVersion: 1,
      kind: "target.cell.commit",
      projectId: args.projectId,
      fileId: args.fileId,
      cellId: c.cellId,
      parentId: c.parentId,
      author: args.author,
      payload: { value: c.value, sourceEventId: c.parentId },
      clientTs: Date.now(),
    }))

    let res: Response
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ events }),
        signal: args.signal,
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : "network error"
      throw new Error(`Target commit failed: ${reason}`)
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      throw new Error(
        `Target commit failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      )
    }
    uploaded += chunk.length
    args.onProgress?.(uploaded, total)
  }
}
