import { usesHostedTranscription } from "./transcription-preference"
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
import { runTranscribeAll, type TranscribeRunReport } from "./batch-audio"
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
   *  transcript emits queue there) and revalidates so text appears promptly.
   *  AQU-1917: only runs when the batch actually produced transcripts — a run
   *  the ASR backend rejected goes to `onFailed` instead, so a caller may
   *  report success from here. AQU-2375: and only when EVERY row landed; a
   *  run where some did not goes to `onPartial`. */
  onDone?: (report: TranscribeRunReport | undefined) => void | Promise<void>
  /** AQU-2375: some rows landed and some did not (failed, or never reached).
   *  Their transcripts still need the same flush as `onDone`'s. Without it,
   *  such a run goes to `onDone`. */
  onPartial?: (report: TranscribeRunReport) => void | Promise<void>
  /** AQU-2375: the recording's name. Given, the run is kept so a page reload
   *  does not end it (transcribe-runs.ts). */
  fileName?: string
  /** Sam, 2026-08-18: "it takes a minute to transcribe everything so there
   *  should be a toast that shows that it's loading." Stays silent for a
   *  consent denial or a file with nothing to do, so no toast ever appears for
   *  a run that never happened. */
  onProgress?: (done: number, total: number) => void
  /** AQU-1681: the hosted transcription limit paused the run until this time
   *  (epoch ms), or null when it carries on — so a progress toast can say so
   *  instead of looking stuck for up to a quarter of an hour. */
  onWaiting?: (untilMs: number | null) => void
  /** The batch threw, or (AQU-1917) no row of it transcribed. Only matters to
   *  a caller that put something on screen in `onProgress` and now has to take
   *  it back down. `report` is there when the batch ran to its end. */
  onFailed?: (message: string, report?: TranscribeRunReport) => void
}

/**
 * Run the post-import transcription batch. Never throws — a consent denial or
 * batch failure leaves the file exactly as manual-transcribe users see it.
 */
export async function autoTranscribeImportedMedia(args: AutoTranscribeArgs): Promise<void> {
  try {
    const consented = usesHostedTranscription(args.session, args.projectId)
      ? true
      : await requestAiModelConsent(WHISPER_MODEL)
    if (!consented) return
    const report = await runTranscribeAll({
      cells: args.seed.cells,
      projectId: args.projectId,
      session: args.session,
      sourceLanguage: args.sourceLanguage,
      targetLanguage: args.targetLanguage,
      onProgress: args.onProgress,
      ...(args.onWaiting ? { onWaiting: args.onWaiting } : {}),
      ...(args.fileName !== undefined ? { keep: { fileId: args.seed.fileId, fileName: args.fileName, kind: "import" as const } } : {}),
    }) as TranscribeRunReport | undefined
    // Nothing ran (every row already had text, or the cost was declined):
    // nothing to report.
    if (report && !report.started) return
    // AQU-1917: a row whose ASR call failed RESOLVES — `runTranscribeAll` only
    // throws when the batch itself dies — so a run in which the ASR endpoint
    // rejected everything once reached `onDone` and said "Transcribed N
    // sections of …" over a file that had gained no text. AQU-2375: the batch
    // now counts each row, so a run where SOME failed is said as well; the
    // shared clip status (one per recording, not per row) could not.
    if (report && report.failed.length > 0 && report.transcribed === 0) {
      args.onFailed?.(report.failed[0]!.message, report)
      return
    }
    if (report && (report.failed.length > 0 || report.transcribed < report.total) && args.onPartial) {
      await args.onPartial(report)
      return
    }
    await args.onDone?.(report)
  } catch (e) {
    console.warn("[auto-transcribe] post-import batch failed:", e)
    args.onFailed?.(e instanceof Error ? e.message : String(e))
  }
}
