/**
 * How closely Change voice should match the cloned voice (AQU-1109).
 *
 * Device-local default for the file-wide batch. A cell card does not read or
 * write this: it shows the quality stamped on the clip it is looking at.
 * Missing or corrupt storage is Standard —
 * Seed-VC's own normal setting — rather than the fast one, which sounds rough.
 *
 * Key schema: `aq.change-voice-quality.v1` (`"fast"` | `"standard"` | `"high"`).
 */

import { useSyncExternalStore } from "react"
import {
  CHANGE_VOICE_QUALITIES,
  CHANGE_VOICE_QUALITY_STEPS,
  type ChangeVoiceQuality,
} from "@/lib/audio/change-voice"
import type { MessageKey } from "@/lib/i18n/messages/en"

export const CHANGE_VOICE_QUALITY_LABEL: Record<ChangeVoiceQuality, MessageKey> = {
  fast: "editor.voice.changeVoiceQuality.fast",
  standard: "editor.voice.changeVoiceQuality.standard",
  high: "editor.voice.changeVoiceQuality.high",
}

const STORAGE_KEY = "aq.change-voice-quality.v1"
const DEFAULT_QUALITY: ChangeVoiceQuality = "standard"

const listeners = new Set<() => void>()
let cached: ChangeVoiceQuality | undefined

function notify(): void {
  for (const l of listeners) l()
}

function isQuality(value: string | null): value is ChangeVoiceQuality {
  return (CHANGE_VOICE_QUALITIES as readonly string[]).includes(value ?? "")
}

function read(): ChangeVoiceQuality {
  if (typeof localStorage === "undefined") return DEFAULT_QUALITY
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isQuality(stored) ? stored : DEFAULT_QUALITY
  } catch {
    return DEFAULT_QUALITY
  }
}

function peek(): ChangeVoiceQuality {
  if (cached === undefined) cached = read()
  return cached
}

export function getChangeVoiceQuality(): ChangeVoiceQuality {
  return peek()
}

export function changeVoiceDiffusionSteps(quality: ChangeVoiceQuality = peek()): number {
  return CHANGE_VOICE_QUALITY_STEPS[quality]
}

export function setChangeVoiceQuality(quality: ChangeVoiceQuality): void {
  cached = quality
  if (typeof localStorage !== "undefined") {
    try {
      if (quality === DEFAULT_QUALITY) localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, quality)
    } catch {
      // quota / access denied — the in-memory cache still reflects the edit
    }
  }
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useChangeVoiceQuality(): ChangeVoiceQuality {
  return useSyncExternalStore(subscribe, peek, () => DEFAULT_QUALITY)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetChangeVoiceQualityCacheForTests(): void {
  cached = undefined
}
