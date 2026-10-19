// Zero-shot examples: the (audio, transcript) pairs from this project that
// teach Omnilingual ZS the language (spec §4). The server ranks them by how
// much their source text overlaps the requesting cell's (it reads that text
// itself from `cellId`), excludes that cell, and signs each `audioUrl` for ten
// minutes — so they are fetched once per cell.

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

export async function fetchTranscriptionExamples(args: {
  projectId: string
  fileId: string
  lane?: string
  /** The cell being transcribed. Absent for the picker's project-wide count. */
  cellId?: string
  limit?: number
  getSyncToken: SyncTokenForFile
}): Promise<TranscriptionExample[]> {
  const token = await args.getSyncToken(args.projectId, args.fileId)
  if (!token) throw new Error(t("audio.error.signInToTranscribe"))
  const params = new URLSearchParams()
  if (args.lane) params.set("lane", args.lane)
  if (args.cellId) params.set("cellId", args.cellId)
  params.set("limit", String(args.limit ?? 10))
  const response = await fetch(
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(args.projectId)}/transcription-examples?${params}`,
    { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) },
  )
  if (!response.ok) throw new Error(t("settings.transcription.zeroShot.examplesFailed", { status: response.status }))
  const body = await response.json() as TranscriptionExample[] | { examples?: TranscriptionExample[] }
  return Array.isArray(body) ? body : body.examples ?? []
}
