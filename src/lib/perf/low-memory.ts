/**
 * low-memory — device-scoped switch for the editor's lightweight render path
 * (AQU-1191).
 *
 * Some translators work on low-spec field devices where the editor's live
 * decorations (health ribbons, remote-presence overlays) and its off-screen
 * overscan are enough to make typing lag or the tab crash. Low-memory mode is
 * the one place that decides "this device is constrained", so every dial-back
 * reads a single answer instead of each surface re-inventing a heuristic.
 *
 * Three states, stored per browser:
 *
 * - `"auto"` (the default, and what a missing key reads as) — the device's own
 *   reported capacity decides.
 * - `"on"` / `"off"` — the user's explicit override, which always wins over
 *   detection. Someone on a reported-tiny device that copes fine can keep the
 *   full editor; someone on a reported-roomy device that still crawls can dial
 *   it back.
 *
 * Detection is a *capability* probe, not a pressure monitor: both signals are
 * fixed for the life of the tab, so it is read once at module load and never
 * polled. Nothing here watches heap usage — a mode that flickered as the heap
 * filled would rearrange the editor under a translator mid-sentence.
 *
 * What the mode dials back lives with each surface, not here:
 * health calculations default off (`lib/health/kill-switch.ts`), the editor
 * list renders the viewport only, and rows drop their per-cell presence
 * overlay. Each is a display-only reduction; no write path, permission, or
 * durable state changes with the mode.
 *
 * Key schema: `low-memory-mode` (value `"on"` | `"off"`; absent = auto).
 */

import { useSyncExternalStore } from "react"

export const LOW_MEMORY_MODE_STORAGE_KEY = "low-memory-mode"

export type LowMemoryMode = "auto" | "on" | "off"

/**
 * `navigator.deviceMemory` reports approximate RAM in GiB, rounded down to a
 * power of two and capped for fingerprinting reasons — so the useful readings
 * are 0.25, 0.5, 1, 2, 4 and 8.
 *
 * The line sits at 2, not 4, because the rounding makes 4 a wide bucket: it
 * covers everything from 4 GB to just under 8 GB, which is an ordinary laptop
 * that runs the full editor fine today. Auto changes what a translator sees
 * without being asked, so it fires only where the tab is genuinely at risk —
 * a reading of 2 or below. Anyone on a 4 GB-reporting device that struggles
 * still has the explicit `on`.
 */
export const LOW_MEMORY_DEVICE_MEMORY_GB = 2

/**
 * `performance.memory.jsHeapSizeLimit` is the tab's own heap ceiling, which is
 * the budget that actually decides whether the tab survives. Desktop Chrome
 * reports ~2-4 GB; a constrained device reports well under that. 1 GiB is the
 * line below which the observed ~2 GB peak (AQU-1104) cannot fit at all.
 */
export const LOW_MEMORY_HEAP_LIMIT_BYTES = 1_073_741_824

export interface DeviceMemorySignals {
  /** `navigator.deviceMemory` in GiB, or undefined where unsupported. */
  deviceMemoryGb?: number
  /** `performance.memory.jsHeapSizeLimit` in bytes, or undefined where unsupported. */
  jsHeapSizeLimitBytes?: number
}

/**
 * Whether these signals describe a constrained device.
 *
 * Either signal alone is enough — they are reported by different browsers, and
 * a device that trips one is the case this mode exists for. An unsupported
 * signal is not evidence of roominess, so a browser that reports neither
 * (Firefox, Safari) reads as unconstrained: auto never dials back a device it
 * cannot measure, and the user still has the explicit override.
 */
export function isConstrainedDevice({
  deviceMemoryGb,
  jsHeapSizeLimitBytes,
}: DeviceMemorySignals): boolean {
  if (deviceMemoryGb != null && deviceMemoryGb > 0 && deviceMemoryGb <= LOW_MEMORY_DEVICE_MEMORY_GB) {
    return true
  }
  if (
    jsHeapSizeLimitBytes != null &&
    jsHeapSizeLimitBytes > 0 &&
    jsHeapSizeLimitBytes <= LOW_MEMORY_HEAP_LIMIT_BYTES
  ) {
    return true
  }
  return false
}

/** Both signals are non-standard, so each is read defensively. */
export function readDeviceMemorySignals(): DeviceMemorySignals {
  const signals: DeviceMemorySignals = {}
  try {
    const reported = (navigator as Navigator & { deviceMemory?: unknown }).deviceMemory
    if (typeof reported === "number" && Number.isFinite(reported)) signals.deviceMemoryGb = reported
  } catch {
    // Access denied / no navigator — leave the signal unreported.
  }
  try {
    const memory = (performance as Performance & { memory?: { jsHeapSizeLimit?: unknown } }).memory
    const limit = memory?.jsHeapSizeLimit
    if (typeof limit === "number" && Number.isFinite(limit)) signals.jsHeapSizeLimitBytes = limit
  } catch {
    // Same — a missing `performance.memory` is silence, not a roomy device.
  }
  return signals
}

const listeners = new Set<() => void>()

/** Fixed for the life of the tab; see the module note on why it is not polled. */
let detectedConstrained = isConstrainedDevice(readDeviceMemorySignals())

/** Cached so useSyncExternalStore's getSnapshot stays cheap and stable. */
let mode = readMode()

function readMode(): LowMemoryMode {
  try {
    const stored = localStorage.getItem(LOW_MEMORY_MODE_STORAGE_KEY)
    if (stored === "on" || stored === "off") return stored
  } catch {
    // Private-mode / storage-disabled browsers fall through to auto.
  }
  return "auto"
}

function notify(): void {
  for (const listener of listeners) listener()
}

/** True when this device reports itself constrained, ignoring any override. */
export function isConstrainedDeviceDetected(): boolean {
  return detectedConstrained
}

export function getLowMemoryMode(): LowMemoryMode {
  return mode
}

export function setLowMemoryMode(next: LowMemoryMode): void {
  try {
    if (next === "auto") localStorage.removeItem(LOW_MEMORY_MODE_STORAGE_KEY)
    else localStorage.setItem(LOW_MEMORY_MODE_STORAGE_KEY, next)
  } catch {
    // Storage-disabled browsers keep the in-memory choice for this session.
  }
  if (mode === next) return
  mode = next
  notify()
}

/** The resolved answer every dial-back reads: an override, else detection. */
export function isLowMemoryActive(): boolean {
  if (mode === "on") return true
  if (mode === "off") return false
  return detectedConstrained
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Subscribe to the resolved mode. Non-React consumers that must recompute a
 * cached default when the mode changes use this directly — see the health
 * kill switch.
 */
export function subscribeLowMemory(listener: () => void): () => void {
  return subscribe(listener)
}

/** Reactive read of the three-state setting, for the settings control itself. */
export function useLowMemoryMode(): LowMemoryMode {
  return useSyncExternalStore(subscribe, getLowMemoryMode, () => "auto" as const)
}

/** Reactive read of the resolved mode, for the surfaces that dial back. */
export function useLowMemoryActive(): boolean {
  return useSyncExternalStore(subscribe, isLowMemoryActive, () => false)
}

/** Test helper: re-read storage and re-probe the device signals. */
export function __resetLowMemoryForTests(): void {
  detectedConstrained = isConstrainedDevice(readDeviceMemorySignals())
  mode = readMode()
  notify()
}
