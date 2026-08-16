/**
 * audio-quality-pref — device-scoped preference for how generated voices play
 * on the media page.
 *
 * Client-synthesized voices upload compressed (webm/opus) with the original
 * WAV kept as an unattached sibling object (see lib/audio/lossless-sibling).
 * Compressed is the right default — it is what the cache warms and what slow
 * connections want — but a listener on a fast connection can flip to the
 * original WAV. A device setting, not a project one: bandwidth is a property
 * of where you are sitting, not of the project.
 *
 * Stored only when the user opts INTO "original", so a missing key reads as
 * the default. Key schema: `aq.audio-quality.v1` (value `"original"`).
 */

import { useSyncExternalStore } from "react"

const STORAGE_KEY = "aq.audio-quality.v1"

export type AudioQuality = "compressed" | "original"

const listeners = new Set<() => void>()

/** Cached snapshot so useSyncExternalStore gets a stable value between writes. */
let cached: AudioQuality | undefined

function notify(): void {
  for (const l of listeners) l()
}

function read(): AudioQuality {
  if (typeof localStorage === "undefined") return "compressed"
  try {
    return localStorage.getItem(STORAGE_KEY) === "original" ? "original" : "compressed"
  } catch {
    return "compressed"
  }
}

function peek(): AudioQuality {
  if (cached === undefined) cached = read()
  return cached
}

/** The quality generated voices should play at (plain read for non-React code). */
export function getAudioQualityPref(): AudioQuality {
  return peek()
}

export function setAudioQualityPref(quality: AudioQuality): void {
  cached = quality
  if (typeof localStorage !== "undefined") {
    try {
      if (quality === "original") localStorage.setItem(STORAGE_KEY, "original")
      else localStorage.removeItem(STORAGE_KEY)
    } catch {
      // quota / access denied — the in-memory cache still reflects the edit
    }
  }
  notify()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Reactive read of the playback-quality preference. */
export function useAudioQualityPref(): AudioQuality {
  return useSyncExternalStore(subscribe, peek, () => "compressed" as const)
}

/** Test helper: forget the cached snapshot so a fresh localStorage is read. */
export function resetAudioQualityPrefCacheForTests(): void {
  cached = undefined
}
