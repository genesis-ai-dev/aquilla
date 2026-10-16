// Zero-shot examples: the (audio, transcript) pairs from this project that
// teach Omnilingual ZS the language (spec §2). The server ranks them —
// validated first, then by how much their source text overlaps this cell's —
// and signs each `audioUrl` for ten minutes, so they are fetched once per cell.

import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"
import { t } from "@/lib/i18n/standalone"
import type { SyncTokenForFile } from "./upload"

export interface TranscriptionExample {
  cellId: string
  fileId: string
  text: string
  durationMs: number
  audioUrl: string
}

/** Enough of the cell's source text to rank by overlap, and to fit a URL. */
const SOURCE_TEXT_MAX = 500

export async function fetchTranscriptionExamples(args: {
  projectId: string
  fileId: string
  lane?: string
  sourceText?: string
  excludeCellId?: string
  getSyncToken: SyncTokenForFile
}): Promise<TranscriptionExample[]> {
  const token = await args.getSyncToken(args.projectId, args.fileId)
  if (!token) throw new Error(t("audio.error.signInToTranscribe"))
  const params = new URLSearchParams()
  if (args.lane) params.set("lane", args.lane)
  const sourceText = args.sourceText?.trim().slice(0, SOURCE_TEXT_MAX)
  if (sourceText) params.set("sourceText", sourceText)
  if (args.excludeCellId) params.set("excludeCellId", args.excludeCellId)
  const response = await fetch(
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(args.projectId)}/transcription-examples?${params}`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) },
  )
  if (!response.ok) throw new Error(t("settings.transcription.zeroShot.examplesFailed", { status: response.status }))
  const body = await response.json() as TranscriptionExample[] | { examples?: TranscriptionExample[] }
  return Array.isArray(body) ? body : body.examples ?? []
}
