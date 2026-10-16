import { t } from "@/lib/i18n/standalone"
import { AUTH_BASE } from "@/lib/frontier/auth"
import { buildTranscriptionRequest, type TranscriptionRequestExample } from "./transcription-request"
import { whisperLanguageFromTag } from "./language"
import { getTranscriptionModel, type TranscriptionModel } from "./transcription-model"
import { fetchTranscriptionExamples } from "./transcription-examples"
import { ensureZsReady, type WarmupUi } from "./omni-warmup"
import { toastWarmupUi, toastZeroShotDisabled, toastZeroShotNoExamples } from "./omni-warmup-toast"
import type { SyncTokenForFile } from "./upload"
import type { TranscriptionResult } from "./transcribe"

export interface HostedTranscriptionOptions {
  /** The lane's raw language tag; the server picks Whisper or Omnilingual by it. */
  language?: string
  model?: TranscriptionModel
  /** Zero-shot only: the project's (audio, transcript) pairs. */
  examples?: TranscriptionRequestExample[]
}

/** The server answered 403 `zero_shot_disabled`: the org turned ZS off. */
export class ZeroShotDisabledError extends Error {
  constructor() {
    super(t("settings.transcription.zeroShot.disabledByOrg"))
    this.name = "ZeroShotDisabledError"
  }
}

/**
 * Seconds of audio per request. Whisper takes a minute; Omnilingual must stay
 * under 40 s and ZS learned on 30 s clips, so anything the server will not send
 * to Whisper goes in 30 s windows. With no tag at all the server auto-detects
 * with Whisper, so that keeps the minute too.
 */
export function hostedWindowSeconds(model: TranscriptionModel, language?: string): number {
  if (model !== "auto") return 30
  return !language || whisperLanguageFromTag(language) !== undefined ? 60 : 30
}

/**
 * The tag as the server should see it. Only something shaped like a language
 * CODE is sent: a language NAME ("Spanish", "Tripuri") or a leaked lane id is
 * dropped, so Whisper auto-detects as it always has instead of the server
 * reading an unknown word as a low-resource language.
 */
export function hostedLanguageTag(tag?: string): string | undefined {
  const value = tag?.trim()
  if (!value || /^[0-9a-f]{8}$/i.test(value)) return undefined
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(value) ? value : undefined
}

// Each request is one window. Long clips retain clip-relative timings.
export async function transcribeHostedPcm(
  pcm: Float32Array,
  jwt: string,
  projectId: string,
  opts: HostedTranscriptionOptions = {},
): Promise<TranscriptionResult> {
  const result: TranscriptionResult = { text: "", chunks: [] }
  const model = opts.model ?? "auto"
  const windowSamples = hostedWindowSeconds(model, opts.language) * 16000
  for (let offset = 0; offset < pcm.length; offset += windowSamples) {
    const response = await fetch(`${AUTH_BASE}/api/v1/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(await buildTranscriptionRequest(
        pcm.subarray(offset, offset + windowSamples), projectId, opts.language,
        model === "zs" ? { model, examples: opts.examples } : {},
      )),
      signal: AbortSignal.timeout(90000),
    })
    if (!response.ok) {
      const failure = await response.json().catch(() => null) as { error?: string } | null
      if (["weekly_ai_allowance_exhausted", "credit_cap_exceeded"].includes(failure?.error ?? "")) {
        throw new Error(t("settings.transcription.capacityExceeded"))
      }
      if (response.status === 403 && failure?.error === "zero_shot_disabled") throw new ZeroShotDisabledError()
      throw new Error(`Hosted transcription failed (${response.status}). Try again.`)
    }
    const part = await response.json() as TranscriptionResult
    result.text = [result.text, part.text].filter(Boolean).join(" ")
    const seconds = offset / 16000
    result.chunks.push(...part.chunks.map(chunk => ({
      ...chunk, start: chunk.start + seconds, end: chunk.end + seconds,
    })))
  }
  return result
}

/** The cell a zero-shot run is for: where its examples come from. */
export interface ZeroShotCellContext {
  cellId: string
  fileId: string
  /** The cell's source text, which the server ranks examples against. */
  sourceText?: string
  /** The target lane the take was recorded in. */
  lane?: string
  getSyncToken: SyncTokenForFile
}

/**
 * The hosted path with the account's model choice applied. ZS runs only for a
 * take on a cell (`zeroShot`), with at least one example, once the model is
 * warm; otherwise — and when the org has turned ZS off — the automatic model.
 */
export async function transcribeHosted(
  pcm: Float32Array,
  args: {
    jwt: string
    projectId: string
    username?: string
    language?: string
    zeroShot?: ZeroShotCellContext
    warmupUi?: WarmupUi
  },
): Promise<TranscriptionResult> {
  const language = hostedLanguageTag(args.language)
  const auto = () => transcribeHostedPcm(pcm, args.jwt, args.projectId, { language, model: "auto" })
  const cell = args.zeroShot
  if (getTranscriptionModel(args.username) !== "zs" || !cell) return auto()

  const examples = await fetchTranscriptionExamples({
    projectId: args.projectId,
    fileId: cell.fileId,
    lane: cell.lane,
    sourceText: cell.sourceText,
    excludeCellId: cell.cellId,
    getSyncToken: cell.getSyncToken,
  })
  if (examples.length === 0) {
    toastZeroShotNoExamples()
    return auto()
  }
  const warm = await ensureZsReady(args.jwt, args.projectId, args.warmupUi ?? toastWarmupUi)
  if (warm.kind === "use-auto") return auto()
  try {
    return await transcribeHostedPcm(pcm, args.jwt, args.projectId, {
      language, model: "zs",
      examples: examples.map(example => ({ url: example.audioUrl, text: example.text })),
    })
  } catch (error) {
    if (!(error instanceof ZeroShotDisabledError)) throw error
    toastZeroShotDisabled()
    return auto()
  }
}
