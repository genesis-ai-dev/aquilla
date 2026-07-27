// AQU-701: pure helpers for the "Configure voice & transcription" setup step.
// Kept separate from the React component so the validation + progress-formatting
// logic is unit-testable without rendering.

import type { ModelPrefetchStatus } from "@/lib/audio/prefetch"

/**
 * Format a byte count as megabytes for a download read-out. Uses one decimal
 * under 10 MB so early progress on a ~140 MB pull still visibly moves.
 */
export function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (!Number.isFinite(mb) || mb <= 0) return "0 MB"
  if (mb >= 10) return `${Math.round(mb)} MB`
  return `${mb.toFixed(1)} MB`
}

/**
 * A Google AI Studio (Gemini) key looks like `AIza` followed by url-safe
 * characters (39 chars in practice). We can't verify it against Google without
 * a network round-trip, so this is a *format guard*: it stops silent acceptance
 * of obviously-wrong input (empty, whitespace, a pasted URL, a truncated paste)
 * while never rejecting a legitimately-shaped key.
 */
export function isValidGeminiKey(key: string): boolean {
  return /^AIza[0-9A-Za-z_-]{20,}$/.test(key.trim())
}

export interface DownloadReadout {
  /** 0..100 when the server sent a Content-Length; null when it's unknown. */
  pct: number | null
  /** Human-readable one-liner, e.g. "45% · 63 MB / 140 MB". */
  label: string
}

/**
 * Turn a raw `downloading` status into a size-and-progress read-out for the UI.
 * `fallbackSizeMb` is the model's advertised size, shown when the CDN omits a
 * Content-Length (so the user still sees *what* and *how big*, not a stalled bar).
 */
export function describeModelDownload(
  status: Extract<ModelPrefetchStatus, { kind: "downloading" }>,
  fallbackSizeMb: number,
): DownloadReadout {
  if (status.total > 0) {
    const pct = Math.min(100, Math.max(0, Math.round((status.loaded / status.total) * 100)))
    return { pct, label: `${pct}% · ${formatMb(status.loaded)} / ${formatMb(status.total)}` }
  }
  if (status.loaded > 0) {
    return { pct: null, label: `${formatMb(status.loaded)} of ~${fallbackSizeMb} MB` }
  }
  return { pct: null, label: `Starting download… (~${fallbackSizeMb} MB)` }
}
