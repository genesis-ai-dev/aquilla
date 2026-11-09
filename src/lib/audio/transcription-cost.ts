// AQU-2426: what transcribing a recording will cost, worked out in the browser
// before anything runs (board 58, Sam Nov 5: "Import and transcribe… shows what
// it will cost before it runs").
//
// Everything here is known before the first request, so nothing is spent to
// find out:
//   • minutes, from each recording's measured length;
//   • requests, one per window of audio: a minute on Whisper and Qwen, 30 s on
//     Omnilingual (`hostedWindowSeconds`), so "one for each minute" or two.
//     A window is cut at the quietest moment in its last 5 s (asr-windows.ts),
//     so it runs a little short and a long recording takes a few more requests
//     than its minutes: the count is "about", from the middle of that range;
//   • roughly how long, at one request at a time (as the words run sends them,
//     line-words-run.ts) of about 8 s each, plus the wait at the hosted limit
//     (60 requests per person every 15 minutes,
//     auth-worker/src/routes/transcription.ts) once a run passes it;
//   • the model, from the person's Preferences, with Automatic resolved for the
//     project's language the way the server routes it (asr-catalog).
// Transcribing on this device (Whisper in the browser) sends no requests and
// pays nothing, so it has no limit and no credits.

import { toQwenCode, toWhisperCode, autoRouteIsOpenRouter } from "./asr-catalog"
import { hostedLanguageTag, hostedWindowSeconds } from "./transcribe-hosted"
import type { TranscriptionModel } from "./transcription-model"

/** The hosted limit: requests per person per window (transcription.ts). */
export const HOSTED_REQUEST_LIMIT = 60
export const HOSTED_LIMIT_WINDOW_SEC = 15 * 60
/** Requests in flight at once, and roughly how long each takes. One at a
 *  time: the words run awaits each window before the next (review, Nov 9;
 *  this said two, so a run took about twice as long as shown). */
export const REQUESTS_AT_ONCE = 1
export const SECONDS_PER_REQUEST = 8
/** How far back from its full length a window's cut may fall (asr-windows.ts
 *  SEARCH_SEC): a window carries between `windowSec − 5` and `windowSec`. */
export const WINDOW_CUT_SEARCH_SEC = 5

/**
 * About how many requests `ms` of audio takes at `windowSec` a window. Audio
 * that fits one window is one request. Longer audio is counted at the middle
 * of what a window can carry, so the figure is neither the fewest the run
 * could send (which it used to be, and ran a few over) nor the most.
 */
export function requestsFor(ms: number, windowSec: number): number {
  if (!(ms > windowSec * 1000)) return 1
  return Math.ceil(ms / ((windowSec - WINDOW_CUT_SEARCH_SEC / 2) * 1000) - 1e-9)
}

/** The model that will actually run on a source recording. */
export type SourceModel = "whisper" | "qwen3-asr" | "omni-ctc"

/**
 * The model a source recording is sent to. Zero-shot learns from a lane's
 * takes and is never used on a source clip, so it runs as Automatic here
 * (`sourceClipWindowSeconds` does the same).
 */
export function resolveSourceModel(chosen: TranscriptionModel, languageTag?: string): SourceModel {
  if (chosen === "whisper" || chosen === "qwen3-asr" || chosen === "omni-ctc") return chosen
  // The server's order (spec §1): Qwen3-ASR for Chinese varieties, then
  // Whisper, then Qwen for the rest it knows, then Omnilingual CTC. An empty
  // or unknown tag stays on Whisper's auto-detect.
  const tag = hostedLanguageTag(languageTag)
  if (!autoRouteIsOpenRouter(tag)) return "omni-ctc"
  if (!tag) return "whisper"
  if (toQwenCode(tag) === "zh") return "qwen3-asr"
  if (toWhisperCode(tag) !== undefined) return "whisper"
  return toQwenCode(tag) !== undefined ? "qwen3-asr" : "whisper"
}

export interface TranscriptionCost {
  /** Total audio, ms. */
  audioMs: number
  /** How many recordings it covers. */
  recordings: number
  /** Runs on this device: no requests, no credits, no limit. */
  onDevice: boolean
  /** Hosted requests (0 on this device). */
  requests: number
  /** Seconds of audio one request carries. */
  windowSec: number
  model: SourceModel
  /** The person left the model on Automatic. */
  automatic: boolean
  /** Rough seconds to finish, including any wait at the limit (0 on device). */
  seconds: number
  /** The run passes the hosted limit and waits part of the way. */
  waitsAtLimit: boolean
}

/**
 * The cost of transcribing these recordings. A recording whose length is not
 * known counts as one window.
 */
export function estimateTranscriptionCost(args: {
  durationsMs: readonly (number | undefined)[]
  chosenModel: TranscriptionModel
  languageTag?: string
  onDevice: boolean
}): TranscriptionCost {
  const model = args.onDevice ? "whisper" : resolveSourceModel(args.chosenModel, args.languageTag)
  const windowSec = args.onDevice
    ? 30
    : hostedWindowSeconds(model, hostedLanguageTag(args.languageTag))
  let audioMs = 0
  let requests = 0
  for (const ms of args.durationsMs) {
    const len = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0
    audioMs += len
    requests += requestsFor(len, windowSec)
  }
  if (args.onDevice) {
    return {
      audioMs, recordings: args.durationsMs.length, onDevice: true, requests: 0, windowSec,
      model, automatic: args.chosenModel === "auto", seconds: 0, waitsAtLimit: false,
    }
  }
  return {
    audioMs,
    recordings: args.durationsMs.length,
    onDevice: false,
    requests,
    windowSec,
    model,
    automatic: args.chosenModel === "auto" || args.chosenModel === "omni-zs",
    seconds: hostedRunSeconds(requests),
    waitsAtLimit: requests > HOSTED_REQUEST_LIMIT,
  }
}

/**
 * Rough seconds for `requests` hosted requests: one at a time, ~8 s each, and
 * past every 60 a wait until the quarter-hour since that block began is up.
 */
export function hostedRunSeconds(requests: number): number {
  if (requests <= 0) return 0
  const blockSec = (n: number) => Math.ceil(n / REQUESTS_AT_ONCE) * SECONDS_PER_REQUEST
  const fullBlocks = Math.floor((requests - 1) / HOSTED_REQUEST_LIMIT)
  const last = requests - fullBlocks * HOSTED_REQUEST_LIMIT
  return fullBlocks * Math.max(HOSTED_LIMIT_WINDOW_SEC, blockSec(HOSTED_REQUEST_LIMIT)) + blockSec(last)
}

/**
 * Rounded for reading: under a minute in 10 s steps (at least 10 s), under ten
 * minutes to the minute, then to five minutes.
 */
export function roundedDuration(seconds: number): { minutes: number } | { seconds: number } {
  if (seconds < 60) return { seconds: Math.max(10, Math.round(seconds / 10) * 10) }
  const minutes = seconds / 60
  if (minutes < 10) return { minutes: Math.max(1, Math.round(minutes)) }
  return { minutes: Math.round(minutes / 5) * 5 }
}

/** Whole minutes of audio for the "Audio" line, at least 1 when there is any. */
export function audioMinutes(audioMs: number): number {
  if (audioMs <= 0) return 0
  return Math.max(1, Math.round(audioMs / 60_000))
}
