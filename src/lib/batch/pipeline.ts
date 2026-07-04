// Batch translation pipeline — the engine behind the frozen Batch API v1
// contract (BATCH_ENDPOINT_CONTRACT.md). Transport-agnostic: the stub server
// (parity/batch/stub-server.ts) and the future Worker route both wrap this
// service. All new surface: nothing existing changes (C7); the Worker mount
// will sit behind the `batchApi` feature flag, default off.
import {
  type BatchDeps,
  type BatchResultsResponse,
  type BatchStatus,
  type BatchStatusResponse,
  type CreateBatchRequest,
  type CreateBatchResponse,
  type SegmentResult,
  DEFAULT_RESULTS_PAGE,
  MAX_RESULTS_PAGE,
  MAX_SEGMENTS_PER_REQUEST,
  MAX_SEGMENT_CODEPOINTS,
} from "./types"

export class BatchApiError extends Error {
  constructor(
    public httpStatus: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

interface StoredBatch {
  id: string
  token: string
  request: CreateBatchRequest
  status: BatchStatus
  createdAt: number
  finishedAt: number | null
  results: SegmentResult[]
  cancelled: boolean
}

const BCP47_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/

let counter = 0
const nextId = (prefix: string): string =>
  `${prefix}_${(++counter).toString(36).padStart(6, "0")}${Math.abs(hash(String(counter)))
    .toString(36)
    .slice(0, 6)}`

const hash = (s: string): number => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}

export function validateCreateRequest(body: unknown): CreateBatchRequest {
  const b = body as Partial<CreateBatchRequest> | null
  if (!b || typeof b !== "object") throw new BatchApiError(400, "invalid_request", "body must be a JSON object")
  if (typeof b.projectId !== "string" || !b.projectId) {
    throw new BatchApiError(400, "invalid_request", "projectId is required")
  }
  for (const field of ["sourceLang", "targetLang"] as const) {
    const v = b[field]
    if (typeof v !== "string" || !v) throw new BatchApiError(400, "invalid_request", `${field} is required`)
    if (!BCP47_RE.test(v)) throw new BatchApiError(422, "unsupported_language", `${field} "${v}" is not a valid BCP 47 tag`)
  }
  if (!Array.isArray(b.segments) || b.segments.length === 0) {
    throw new BatchApiError(400, "invalid_request", "segments must be a non-empty array")
  }
  if (b.segments.length > MAX_SEGMENTS_PER_REQUEST) {
    throw new BatchApiError(413, "too_many_segments", `max ${MAX_SEGMENTS_PER_REQUEST} segments per request`)
  }
  const ids = new Set<string>()
  for (const seg of b.segments) {
    if (!seg || typeof seg.id !== "string" || !seg.id || typeof seg.text !== "string") {
      throw new BatchApiError(400, "invalid_request", "each segment needs a string id and text")
    }
    if (ids.has(seg.id)) throw new BatchApiError(400, "invalid_request", `duplicate segment id "${seg.id}"`)
    ids.add(seg.id)
    if ([...seg.text].length > MAX_SEGMENT_CODEPOINTS) {
      throw new BatchApiError(400, "invalid_request", `segment "${seg.id}" exceeds ${MAX_SEGMENT_CODEPOINTS} code points`)
    }
  }
  const opts = b.options ?? {}
  if (opts.maxExamplesPerSegment != null && (opts.maxExamplesPerSegment < 0 || opts.maxExamplesPerSegment > 10)) {
    throw new BatchApiError(400, "invalid_request", "options.maxExamplesPerSegment must be 0..10")
  }
  if (opts.temperature != null && (opts.temperature < 0 || opts.temperature > 1)) {
    throw new BatchApiError(400, "invalid_request", "options.temperature must be 0..1")
  }
  return b as CreateBatchRequest
}

export class BatchService {
  private batches = new Map<string, StoredBatch>()
  private idempotency = new Map<string, { bodyHash: number; response: CreateBatchResponse }>()
  private queue: string[] = []

  constructor(private deps: BatchDeps) {}

  create(body: unknown, idempotencyKey?: string): CreateBatchResponse {
    const request = validateCreateRequest(body)
    const bodyHash = hash(JSON.stringify(body))
    if (idempotencyKey) {
      const prior = this.idempotency.get(idempotencyKey)
      if (prior) {
        if (prior.bodyHash !== bodyHash) {
          throw new BatchApiError(409, "idempotency_conflict", "idempotency key was used with a different body")
        }
        return prior.response
      }
    }
    const id = nextId("batch")
    const stored: StoredBatch = {
      id,
      token: nextId("btok"),
      request,
      status: "queued",
      createdAt: this.deps.now(),
      finishedAt: null,
      results: request.segments.map((s) => ({
        id: s.id,
        status: "pending",
        translation: null,
        model: null,
        examplesUsed: 0,
      })),
      cancelled: false,
    }
    this.batches.set(id, stored)
    this.queue.push(id)
    const response: CreateBatchResponse = {
      batchId: id,
      batchToken: stored.token,
      status: "queued",
      segmentCount: request.segments.length,
      statusUrl: `/batch/v1/batches/${id}`,
      resultsUrl: `/batch/v1/batches/${id}/results`,
    }
    if (idempotencyKey) this.idempotency.set(idempotencyKey, { bodyHash, response })
    return response
  }

  /** Process queued batches (the worker's queue consumer; tests call directly). */
  async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const id = this.queue.shift() as string
      const batch = this.batches.get(id)
      if (!batch || batch.cancelled) continue
      batch.status = "running"
      const opts = batch.request.options ?? {}
      const maxExamples = opts.maxExamplesPerSegment ?? 5
      const useExamples = opts.useGlobalExamples !== false
      for (let i = 0; i < batch.request.segments.length; i++) {
        if (batch.cancelled) break
        const seg = batch.request.segments[i]
        const result = batch.results[i]
        try {
          const examples =
            useExamples && maxExamples > 0
              ? await this.deps.retrieveExamples({
                  query: seg.text,
                  sourceLang: batch.request.sourceLang,
                  targetLang: batch.request.targetLang,
                  limit: maxExamples,
                })
              : []
          const { translation, model } = await this.deps.translate({
            text: seg.text,
            sourceLang: batch.request.sourceLang,
            targetLang: batch.request.targetLang,
            examples,
            model: opts.model ?? null,
            temperature: opts.temperature ?? 0.2,
            maxLength: seg.maxLength ?? null,
            context: seg.context ?? null,
          })
          result.status = "succeeded"
          result.translation = translation
          result.model = model
          result.examplesUsed = examples.length
        } catch (e) {
          result.status = "failed"
          result.error = { code: "translation_failed", message: String(e).slice(0, 300) }
        }
      }
      if (!batch.cancelled) {
        const failed = batch.results.filter((r) => r.status === "failed").length
        batch.status = failed === 0 ? "succeeded" : failed === batch.results.length ? "failed" : "partially_failed"
        batch.finishedAt = this.deps.now()
      }
    }
  }

  private authorized(batch: StoredBatch, auth: { accountKey?: string; bearer?: string }): boolean {
    return Boolean(auth.accountKey) || auth.bearer === batch.token
  }

  status(batchId: string, auth: { accountKey?: string; bearer?: string }): BatchStatusResponse {
    const batch = this.batches.get(batchId)
    if (!batch || !this.authorized(batch, auth)) {
      throw new BatchApiError(404, "batch_not_found", "no such batch for these credentials")
    }
    return {
      batchId: batch.id,
      status: batch.status,
      segmentCount: batch.results.length,
      completedCount: batch.results.filter((r) => r.status === "succeeded").length,
      failedCount: batch.results.filter((r) => r.status === "failed").length,
      createdAt: new Date(batch.createdAt).toISOString(),
      finishedAt: batch.finishedAt ? new Date(batch.finishedAt).toISOString() : null,
      queueDepthAhead: this.queue.filter((qid) => {
        const other = this.batches.get(qid)
        return other != null && other.createdAt < batch.createdAt
      }).length,
    }
  }

  results(
    batchId: string,
    auth: { accountKey?: string; bearer?: string },
    cursor?: string,
    limit?: number,
  ): BatchResultsResponse {
    const batch = this.batches.get(batchId)
    if (!batch || !this.authorized(batch, auth)) {
      throw new BatchApiError(404, "batch_not_found", "no such batch for these credentials")
    }
    const pageSize = Math.min(Math.max(limit ?? DEFAULT_RESULTS_PAGE, 1), MAX_RESULTS_PAGE)
    let start = 0
    if (cursor) {
      // Opaque-to-clients cursor: "c" + offset (no Buffer — this module runs in
      // Workers and the browser).
      const parsed = cursor.startsWith("c") ? Number.parseInt(cursor.slice(1), 10) : Number.NaN
      if (Number.isNaN(parsed) || parsed < 0) throw new BatchApiError(400, "invalid_request", "bad cursor")
      start = parsed
    }
    const page = batch.results.slice(start, start + pageSize)
    const nextStart = start + page.length
    return {
      batchId: batch.id,
      results: page,
      nextCursor: nextStart < batch.results.length ? `c${nextStart}` : null,
    }
  }

  cancel(batchId: string, auth: { accountKey?: string; bearer?: string }): { batchId: string; status: BatchStatus; cancelled: boolean } {
    const batch = this.batches.get(batchId)
    if (!batch || !this.authorized(batch, auth)) {
      throw new BatchApiError(404, "batch_not_found", "no such batch for these credentials")
    }
    if (batch.status === "queued" || batch.status === "running") {
      batch.cancelled = true
      batch.status = "failed"
      batch.finishedAt = this.deps.now()
      return { batchId: batch.id, status: batch.status, cancelled: true }
    }
    return { batchId: batch.id, status: batch.status, cancelled: batch.cancelled }
  }
}
