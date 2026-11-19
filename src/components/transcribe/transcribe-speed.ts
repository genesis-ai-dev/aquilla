// The Transcribe lens's own speech-model choice: Fast or Smart.
//
// Fast is the default. The first pass only has to be quick and faithful to the
// sounds, because the AI cleanup then rewrites it the way the team writes —
// so a rough phonetic transcript that appears at once beats a better one that
// arrives after a GPU has woken up (Ryder, 2026-11-17: "fast beats accurate
// because an LLM will be cleaning it up using examples anyways").
//
// What each choice runs depends on the language of the speech:
//   - A language Whisper or Qwen knows goes to them either way. They are
//     already quick, need no wake-up, and beat a phonetic model there.
//   - Otherwise Fast is Omnilingual CTC 300M on CPU (`omni-fast`), and Smart
//     is zero-shot — the model that learns from the lane's own corrected takes
//     — falling back quietly to the fast model when it cannot run (no examples
//     yet, or the workspace has it turned off).
//   - A model pinned in Preferences is what Smart runs; that is the person's
//     explicit choice.

import { useSyncExternalStore } from "react"
import { autoRouteIsOpenRouter } from "@/lib/audio/asr-catalog"
import type { OmniModelName } from "@/lib/audio/omni-warmup"
import { hostedLanguageTag } from "@/lib/audio/transcribe-hosted"
import { getTranscriptionModel, type TranscriptionModel } from "@/lib/audio/transcription-model"
import type { RowModelChoice } from "@/lib/transcript-cleanup/run"

export type TranscribeSpeed = "fast" | "smart"
export const TRANSCRIBE_SPEEDS: readonly TranscribeSpeed[] = ["fast", "smart"]

const prefix = "aq.transcribe-speed.v1."
const listeners = new Set<() => void>()
const memory = new Map<string, TranscribeSpeed>()
const keyFor = (username?: string) => prefix + encodeURIComponent(username ?? "signed-out")

/** Account-specific in this browser, like the model choice in Preferences. */
export function getTranscribeSpeed(username?: string): TranscribeSpeed {
  const key = keyFor(username)
  if (memory.has(key)) return memory.get(key)!
  try { return localStorage.getItem(key) === "smart" ? "smart" : "fast" }
  catch { return "fast" }
}

export function setTranscribeSpeed(username: string | undefined, speed: TranscribeSpeed): void {
  const key = keyFor(username)
  try {
    localStorage.setItem(key, speed)
    memory.delete(key)
  } catch { memory.set(key, speed) }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  window.addEventListener("storage", listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", listener)
  }
}

export function useTranscribeSpeed(username?: string): TranscribeSpeed {
  return useSyncExternalStore(subscribe, () => getTranscribeSpeed(username), () => "fast" as const)
}

/** A language code Whisper or Qwen is known to cover. A name, a lane id or no
 *  tag at all is NOT known: that is what an unwritten language looks like, and
 *  Whisper's auto-detect answers those in some other language entirely. */
function knownToOpenRouter(language: string | undefined): boolean {
  const tag = hostedLanguageTag(language)
  return tag !== undefined && autoRouteIsOpenRouter(tag)
}

/** What a row in `language` runs under `speed` (see the header). */
export function speechChoice(speed: TranscribeSpeed, username: string | undefined, language: string | undefined): RowModelChoice {
  const pinned = getTranscriptionModel(username)
  if (speed === "smart" && pinned !== "auto") return { model: pinned }
  if (knownToOpenRouter(language)) return { model: "auto" }
  return speed === "fast" ? { model: "omni-fast" } : { model: "omni-zs", quietFallback: "omni-fast" }
}

/** The Omnilingual model a choice needs awake, or null when it needs none. */
export function modelToWake(choice: RowModelChoice, language: string | undefined): OmniModelName | null {
  const model: TranscriptionModel = choice.model
  if (model === "omni-fast") return "fast"
  if (model === "omni-zs") return "zs"
  if (model === "omni-ctc") return "ctc"
  if (model === "auto") return autoRouteIsOpenRouter(hostedLanguageTag(language)) ? null : "ctc"
  return null
}
