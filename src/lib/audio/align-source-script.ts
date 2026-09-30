import type { CellData } from "@/hooks/useCells"
import { alignScriptParagraphs, WordAlignmentUnavailableError, type AlignmentWord, type AlignedScriptSegment,
  type ScriptAlignmentResult } from "./script-alignment"
import { collectSourceAlignmentWords } from "./source-alignment"
import type { TranscriptionOptions, TranscriptionResult } from "./transcribe"
import { whisperLanguageFromTag } from "./language"

export interface SourceScriptAlignmentOptions {
  script: string
  cells: readonly CellData[]
  clipUrl: string
  language?: string
  signal?: AbortSignal
  loadAudio(signal?: AbortSignal): Promise<Uint8Array>
  transcribe?(bytes: Uint8Array, options: TranscriptionOptions): Promise<TranscriptionResult>
}

/** Reuse matching source evidence before requesting another model. */
export async function alignSourceScript(options: SourceScriptAlignmentOptions): Promise<ScriptAlignmentResult> {
  options.signal?.throwIfAborted()
  const reusable = (result: { segments: readonly AlignedScriptSegment[] } | null) =>
    result !== null && result.segments.length > 0
      && result.segments.every(segment => !segment.needsReview)
  const tryWordMatch = (words: readonly AlignmentWord[]) => {
    try {
      return alignScriptParagraphs(options.script, words)
    } catch (error) {
      if (error instanceof WordAlignmentUnavailableError) return null
      throw error
    }
  }
  const cached = tryWordMatch(
    collectSourceAlignmentWords(options.cells, options.clipUrl))
  if (cached && reusable(cached)) return cached
  const bytes = await options.loadAudio(options.signal)
  options.signal?.throwIfAborted()
  const transcribe = options.transcribe ?? (await import("./transcribe")).transcribeAudio
  const transcript = await transcribe(bytes, {
    language: whisperLanguageFromTag(options.language),
  })
  options.signal?.throwIfAborted()
  // Keep uncertain matches editable; never send scripts to another service.
  return { ...alignScriptParagraphs(options.script, transcript.chunks),
    method: "whisper-word-match" }
}
