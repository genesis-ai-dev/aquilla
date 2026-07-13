/**
 * Byte-size formatting helpers for import/download progress UIs (AQU-520).
 *
 * The import progress indicators used to show only a percentage / item count,
 * which "feels stalled" on large partner imports (eBible corpora, DCS bundles).
 * These helpers render a transferred/total megabyte readout instead, so the
 * user can see real movement.
 */

const BYTES_PER_MB = 1024 * 1024

/** Format a byte count as a one-decimal megabyte string, e.g. `40.0 MB`. */
export function formatMB(bytes: number): string {
  const mb = Math.max(0, bytes) / BYTES_PER_MB
  return `${mb.toFixed(1)} MB`
}

/**
 * Human-readable byte-transfer progress.
 *
 * - total known (> 0):  `"12.4 / 40.0 MB (31%)"` — transferred, total, percent.
 * - total unknown/0:    `"12.4 MB"` — transferred-so-far only, never a
 *   fabricated/misleading total.
 */
export function formatBytesProgress(
  received: number | undefined,
  total: number | undefined,
): string {
  const rcv = Math.max(0, received ?? 0)
  if (!total || total <= 0) return formatMB(rcv)
  const pct = Math.round((rcv / total) * 100)
  return `${(rcv / BYTES_PER_MB).toFixed(1)} / ${(total / BYTES_PER_MB).toFixed(1)} MB (${pct}%)`
}
