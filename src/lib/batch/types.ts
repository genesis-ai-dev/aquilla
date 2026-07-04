// Types for the Aquilla Batch Translation API v1 — mirror of the FROZEN
// BATCH_ENDPOINT_CONTRACT.md. Do not change shapes without a /batch/v2.

export interface BatchSegmentInput {
  id: string
  text: string
  context?: string | null
  maxLength?: number | null
}

export interface BatchOptions {
  model?: string | null
  useGlobalExamples?: boolean
  maxExamplesPerSegment?: number
  temperature?: number
}

export interface CreateBatchRequest {
  projectId: string
  sourceLang: string
  targetLang: string
  segments: BatchSegmentInput[]
  options?: BatchOptions
}

export type BatchStatus = "queued" | "running" | "succeeded" | "failed" | "partially_failed"

export interface CreateBatchResponse {
  batchId: string
  batchToken: string
  status: "queued"
  segmentCount: number
  statusUrl: string
  resultsUrl: string
}

export interface BatchStatusResponse {
  batchId: string
  status: BatchStatus
  segmentCount: number
  completedCount: number
  failedCount: number
  createdAt: string
  finishedAt: string | null
  queueDepthAhead: number
}

export interface SegmentResult {
  id: string
  status: "succeeded" | "failed" | "pending"
  translation: string | null
  model: string | null
  examplesUsed: number
  error?: { code: string; message: string }
}

export interface BatchResultsResponse {
  batchId: string
  results: SegmentResult[]
  nextCursor: string | null
}

export interface ApiError {
  errors: { code: string; message: string }[]
}

/** Few-shot example retrieved from the global validated-translation index. */
export interface FewShotExample {
  source: string
  target: string
  projectId: string
  orgId: string
}

/** Injected dependencies — the real worker wires the LLM + global-TM index;
 *  tests inject fakes. */
export interface BatchDeps {
  translate(args: {
    text: string
    sourceLang: string
    targetLang: string
    examples: FewShotExample[]
    model: string | null
    temperature: number
    maxLength: number | null
    context: string | null
  }): Promise<{ translation: string; model: string }>
  retrieveExamples(args: {
    query: string
    sourceLang: string
    targetLang: string
    limit: number
  }): Promise<FewShotExample[]>
  now(): number
}

export const MAX_SEGMENTS_PER_REQUEST = 500
export const MAX_SEGMENT_CODEPOINTS = 10_000
export const MAX_RESULTS_PAGE = 500
export const DEFAULT_RESULTS_PAGE = 100
