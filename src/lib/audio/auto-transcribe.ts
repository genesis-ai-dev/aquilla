// AQU-646: auto-transcription after a media import. Sam's confirmed expected
// behavior is that importing an MP3 SURFACES SOURCE TEXT — the user should not
// have to find the Transcribe button before the text view fills in.
//
// Mechanism: the import emitters know everything the batch needs (cell ids,
// the shared clip's url, per-cell trim windows) at emit time, while the
// workspace's cell store only learns about the new file after an unawaitable
// revalidate round-trip — and store cells don't carry attachments anyway. So
// the emitters record a consume-once SEED here, and the workspace's
// import-completion handler consumes it and runs the existing batch machinery
// (`runTranscribeAll`) over the synthesized cells. Consent for the Whisper
// model is requested ONCE up front — a denial skips the auto-run silently
// (the manual Transcribe affordances remain; nothing re-prompts per cell).

import { requestAiModelConsent, WHISPER_MODEL } from "./ai-consent"
import { runTranscribeAll } from "./batch-audio"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"

export interface MediaImportSeed {
  fileId: string
  cells: CellData[]
}

/** Keep only the most recent few seeds — abandoned ones (consumer never ran,
 *  e.g. a crash between emit and handleImported) age out silently. */
const MAX_SEEDS = 8
const seeds = new Map<string, MediaImportSeed>()

export function recordMediaImportSeed(seed: MediaImportSeed): void {
  seeds.delete(seed.fileId)
  seeds.set(seed.fileId, seed)
  while (seeds.size > MAX_SEEDS) {
    const oldest = seeds.keys().next().value as string | undefined
    if (oldest === undefined) break
    seeds.delete(oldest)
  }
}

/** Delete-on-read: each import triggers at most one auto-run. */
export function consumeMediaImportSeed(fileId: string): MediaImportSeed | undefined {
  const seed = seeds.get(fileId)
  if (seed) seeds.delete(fileId)
  return seed
}

export interface MediaSeedSpec {
  cellId: string
  startMs?: number
  endMs?: number
  trimStartMs?: number
  trimEndMs?: number
}

/**
 * Synthesize the minimal CellData the transcribe batch needs from import-time
 * specs. `transcribeCell` reads: id, fileId, medium, selectedAudioId,
 * attachments[selectedAudioId].{url,trimStartMs,trimEndMs}; the batch filter
 * (`needsTranscription`) additionally checks the absent `transcription`.
 * Pure — exported for tests.
 */
export function buildMediaSeedCells(args: {
  fileId: string
  fileName: string
  specs: MediaSeedSpec[]
  /** The attachment audioId EXACTLY as this flow emitted it (the two import
   *  flows differ on the `.ext` suffix — each seed mirrors its own attach). */
  audioId: string
  url: string
  durationMs?: number
}): CellData[] {
  return args.specs.map(
    (s) =>
      ({
        id: s.cellId,
        fileId: args.fileId,
        original: args.fileName,
        translated: "",
        context: "",
        group: "",
        type: "text",
        status: "unvalidated",
        validationStatus: "none",
        activeValidators: [],
        validationHistory: [],
        history: [],
        threads: [],
        medium: "media",
        ...(s.startMs !== undefined ? { startTime: s.startMs / 1000 } : {}),
        ...(s.endMs !== undefined ? { endTime: s.endMs / 1000 } : {}),
        selectedAudioId: args.audioId,
        attachments: {
          [args.audioId]: {
            type: "audio",
            url: args.url,
            ...(s.trimStartMs !== undefined ? { trimStartMs: s.trimStartMs } : {}),
            ...(s.trimEndMs !== undefined ? { trimEndMs: s.trimEndMs } : {}),
            ...(args.durationMs !== undefined ? { durationMs: Math.round(args.durationMs) } : {}),
          },
        },
      }) as CellData,
  )
}

export interface AutoTranscribeArgs {
  seed: MediaImportSeed
  projectId: string
  session: FrontierSession | null
  sourceLanguage?: string
  targetLanguage?: string
  /** Runs after the batch settles — the caller flushes the outbox (the
   *  transcript emits queue there) and revalidates so text appears promptly. */
  onDone?: () => void | Promise<void>
}

/**
 * Run the post-import transcription batch. Never throws — a consent denial or
 * batch failure leaves the file exactly as manual-transcribe users see it.
 */
export async function autoTranscribeImportedMedia(args: AutoTranscribeArgs): Promise<void> {
  try {
    const consented = await requestAiModelConsent(WHISPER_MODEL)
    if (!consented) return
    await runTranscribeAll({
      cells: args.seed.cells,
      projectId: args.projectId,
      session: args.session,
      sourceLanguage: args.sourceLanguage,
      targetLanguage: args.targetLanguage,
    })
    await args.onDone?.()
  } catch (e) {
    console.warn("[auto-transcribe] post-import batch failed:", e)
  }
}
