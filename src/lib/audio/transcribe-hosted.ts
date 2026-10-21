import { t } from "@/lib/i18n/standalone"
import { aiRefusalError } from "@/lib/billing/ai-refusal"
import { AUTH_BASE } from "@/lib/frontier/auth"
import { buildTranscriptionRequest, type TranscriptionRequestExample } from "./transcription-request"
import { autoRouteIsOpenRouter } from "./asr-catalog"
import { windowStarts } from "./asr-windows"
import { getTranscriptionModel, type TranscriptionModel } from "./transcription-model"
import { fetchTranscriptionExamples } from "./transcription-examples"
import { ensureZsReady, type WarmupUi } from "./omni-warmup"
import { promptZeroShotNoExamples, toastWarmupUi, toastZeroShotDisabled } from "./omni-warmup-toast"
import type { SyncTokenForFile } from "./upload"
import type { TranscriptionResult } from "./transcribe"

export interface HostedTranscriptionOptions {
  /** The lane's raw language tag; the server maps it for each model. */
  language?: string
  model?: TranscriptionModel
  /** Zero-shot only: the project's (audio, transcript) pairs. */
  examples?: TranscriptionRequestExample[]
  /**
   * The server answered 503 `asr_warming`: wait for the model, then say
   * whether to send the same window again. Asked at most once per clip.
   */
  onWarming?: () => Promise<boolean>
  /**
   * AQU-1681: the per-user limit (60 requests per 15 minutes) refused this
   * request. Given, the same audio is sent again once this resolves — it is
   * handed the seconds the limiter asked for, and may throw to give up (a
   * cancelled batch). Absent, the refusal is an error, as it always was: a
   * single row's Transcribe button should not sit silently for 15 minutes.
   */
  onRateLimited?: (retryAfterSeconds: number) => Promise<void>
}

/** When the limiter's answer cannot be read (an older server that does not
 *  expose Retry-After), ask again after this long. A refused request costs
 *  nothing. */
export const FALLBACK_RETRY_AFTER_SECONDS = 60

function retryAfterSeconds(response: Response): number {
  const raw = response.headers.get("Retry-After")
  if (!raw) return FALLBACK_RETRY_AFTER_SECONDS
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, (at - Date.now()) / 1000) : FALLBACK_RETRY_AFTER_SECONDS
}

const GRANULARITY_RANK = { word: 0, none: 1, segment: 2 } as const

/** The server answered 403 `zero_shot_disabled`: the org turned ZS off. */
export class ZeroShotDisabledError extends Error {
  constructor() {
    super(t("settings.transcription.zeroShot.disabledByOrg"))
    this.name = "ZeroShotDisabledError"
  }
}

/** ZS has nothing to learn from: no examples in this project's lane. */
export class ZeroShotNoExamplesError extends Error {
  constructor() {
    super(t("settings.transcription.zeroShot.noExamples"))
    this.name = "ZeroShotNoExamplesError"
  }
}

/** The server answered 503 `asr_warming`: the model is still starting. */
export class AsrWarmingError extends Error {
  constructor() {
    super(t("settings.transcription.zeroShot.warmupTitle"))
    this.name = "AsrWarmingError"
  }
}

/**
 * Seconds of audio per request. Whisper and Qwen take a minute; Omnilingual
 * must stay under 40 s and ZS learned on 30 s clips, so 30 s for anything the
 * server will send there — including "auto" for a language only Omnilingual has.
 */
export function hostedWindowSeconds(model: TranscriptionModel, language?: string): number {
  if (model === "whisper" || model === "qwen3-asr") return 60
  if (model === "omni-ctc" || model === "omni-zs") return 30
  return autoRouteIsOpenRouter(language) ? 60 : 30
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

/** AQU-1681: the per-user limit refused the request (429 `rate_limited`). */
export class TranscriptionRateLimitedError extends Error {
  readonly retryAfterSeconds: number
  constructor(retryAfterSeconds: number) {
    super("Hosted transcription failed (429). Try again.")
    this.name = "TranscriptionRateLimitedError"
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * AQU-1681: the window a row of a shared source recording is sent in — the
 * account's model, except zero-shot, which a source clip never uses (it is no
 * lane's speech; see `transcribeHosted`). A batch packs that many seconds of
 * rows into one request.
 */
export function sourceClipWindowSeconds(username: string | undefined, language?: string): number {
  const chosen = getTranscriptionModel(username)
  return hostedWindowSeconds(chosen === "omni-zs" ? "auto" : chosen, hostedLanguageTag(language))
}

type HostedPart = TranscriptionResult

async function postWindow(
  pcm: Float32Array, jwt: string, projectId: string, opts: HostedTranscriptionOptions,
): Promise<HostedPart> {
  const model = opts.model ?? "auto"
  const response = await fetch(`${AUTH_BASE}/api/v1/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(await buildTranscriptionRequest(
      pcm, projectId, opts.language,
      // "auto" is the server default: its requests carry no model field.
      model === "auto" ? {} : { model, ...(model === "omni-zs" ? { examples: opts.examples } : {}) },
    )),
    // Above the server's 140 s Omnilingual timeout: a cold CTC container
    // takes 60–90 s to answer the first request.
    signal: AbortSignal.timeout(150000),
  })
  if (response.ok) return await response.json() as HostedPart
  const failure = await response.json().catch(() => null) as { error?: string } | null
  const code = failure?.error ?? ""
  const refused = aiRefusalError(response.status, failure)
  if (refused) throw refused
  if (response.status === 403 && code === "zero_shot_disabled") throw new ZeroShotDisabledError()
  // `zero_shot_examples_required` is the server branch's name for the same answer.
  if (response.status === 400 && (code === "zs_no_examples" || code === "zero_shot_examples_required")) {
    throw new ZeroShotNoExamplesError()
  }
  if (response.status === 503 && code === "asr_warming") throw new AsrWarmingError()
  if (response.status === 429 && code === "rate_limited") {
    throw new TranscriptionRateLimitedError(retryAfterSeconds(response))
  }
  throw new Error(`Hosted transcription failed (${response.status}). Try again.`)
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
  const windowSec = hostedWindowSeconds(model, opts.language)
  const starts = windowStarts(pcm, windowSec, windowSec === 30)
  let warmRetries = 1
  // AQU-1681: a refusal by the per-user limit sends the same window again
  // once `onRateLimited` has waited it out; without it, it is an error.
  const send = async (window: Float32Array): Promise<HostedPart> => {
    for (;;) {
      try {
        return await postWindow(window, jwt, projectId, opts)
      } catch (error) {
        if (!(error instanceof TranscriptionRateLimitedError) || !opts.onRateLimited) throw error
        await opts.onRateLimited(error.retryAfterSeconds)
      }
    }
  }
  for (let i = 0; i < starts.length; i++) {
    const window = pcm.subarray(starts[i], starts[i + 1] ?? pcm.length)
    let part: HostedPart
    try {
      part = await send(window)
    } catch (error) {
      if (!(error instanceof AsrWarmingError) || !opts.onWarming || warmRetries-- <= 0) throw error
      if (!await opts.onWarming()) throw error
      part = await send(window)
    }
    result.text = [result.text, part.text].filter(Boolean).join(" ")
    const seconds = starts[i] / 16000
    result.chunks.push(...part.chunks.map(chunk => ({
      ...chunk, start: chunk.start + seconds, end: chunk.end + seconds,
    })))
    if (part.model) result.model = part.model
    if (part.timingsApproximate) result.timingsApproximate = true
    // AQU-1681: the coarsest timing any window came back with.
    if (part.granularity && (!result.granularity
      || GRANULARITY_RANK[part.granularity] > GRANULARITY_RANK[result.granularity])) {
      result.granularity = part.granularity
    }
  }
  return result
}

/** The cell a zero-shot run is for: where its examples come from. */
export interface ZeroShotCellContext {
  cellId: string
  fileId: string
  /** The target lane the take was recorded in. */
  lane?: string
  getSyncToken: SyncTokenForFile
}

/**
 * A batch where the project has no examples asks once, not once per cell: the
 * answer is kept for a few minutes per project. Recording more takes is the fix
 * for "none", so the memory is short.
 */
const NO_EXAMPLES_MEMORY_MS = 5 * 60 * 1000
const noExamplesChoice = new Map<string, { at: number; choice: Promise<"omni-ctc" | "cancel"> }>()

function noExamplesChoiceFor(projectId: string): Promise<"omni-ctc" | "cancel"> {
  const kept = noExamplesChoice.get(projectId)
  if (kept && Date.now() - kept.at < NO_EXAMPLES_MEMORY_MS) return kept.choice
  const choice = promptZeroShotNoExamples()
  noExamplesChoice.set(projectId, { at: Date.now(), choice })
  return choice
}

/** @internal — test-only. */
export function __resetHostedTranscriptionForTests(): void {
  noExamplesChoice.clear()
}

/**
 * The hosted path with the account's model choice applied. ZS runs only for a
 * take on a cell (`zeroShot`), with at least one example, once the model is
 * warm. Without examples it offers Omnilingual standard; when the org has
 * turned ZS off, or the person picks it at the warm-up timeout, it runs the
 * automatic model.
 */
export async function transcribeHosted(
  pcm: Float32Array,
  args: {
    jwt: string
    projectId: string
    username?: string
    language?: string
    zeroShot?: ZeroShotCellContext
    /** The take is waiting for the model to start (true), or no longer (false). */
    onWaitingForModel?: (waiting: boolean) => void
    /** AQU-1681: wait out the per-user limit (see `HostedTranscriptionOptions`). */
    onRateLimited?: (retryAfterSeconds: number) => Promise<void>
    warmupUi?: WarmupUi
  },
): Promise<TranscriptionResult> {
  const language = hostedLanguageTag(args.language)
  const run = (model: TranscriptionModel, extra: Partial<HostedTranscriptionOptions> = {}) =>
    transcribeHostedPcm(pcm, args.jwt, args.projectId, {
      language, model, ...(args.onRateLimited ? { onRateLimited: args.onRateLimited } : {}), ...extra,
    })
  const chosen = getTranscriptionModel(args.username)
  const cell = args.zeroShot
  // Zero-shot learns from this lane's takes; a source clip has none to use.
  if (chosen !== "omni-zs") return run(chosen)
  if (!cell) return run("auto")

  const withoutExamples = async () => {
    if (await noExamplesChoiceFor(args.projectId) === "omni-ctc") return run("omni-ctc")
    throw new ZeroShotNoExamplesError()
  }
  const examples = await fetchTranscriptionExamples({
    projectId: args.projectId,
    fileId: cell.fileId,
    lane: cell.lane,
    cellId: cell.cellId,
    getSyncToken: cell.getSyncToken,
  })
  if (examples.length === 0) return withoutExamples()

  const ui = args.warmupUi ?? toastWarmupUi
  const waitForModel = async () => {
    args.onWaitingForModel?.(true)
    try { return await ensureZsReady(args.jwt, args.projectId, ui) }
    finally { args.onWaitingForModel?.(false) }
  }
  if ((await waitForModel()).kind === "use-auto") return run("auto")

  let switchToAuto = false
  try {
    return await run("omni-zs", {
      examples: examples.map(example => ({ url: example.audioUrl, text: example.text })),
      onWarming: async () => {
        switchToAuto = (await waitForModel()).kind === "use-auto"
        return !switchToAuto
      },
    })
  } catch (error) {
    if (error instanceof AsrWarmingError && switchToAuto) return run("auto")
    if (error instanceof ZeroShotNoExamplesError) return withoutExamples()
    if (!(error instanceof ZeroShotDisabledError)) throw error
    toastZeroShotDisabled()
    return run("auto")
  }
}
