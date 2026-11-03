// Times as the Station writes and reads them (AQU-2327): "m:ss.cc", to the
// hundredth of a second (the ETEN editor's precision, Oct 24).

/** 4.2 → "0:04.20"; 62.35 → "1:02.35". Negative reads as zero. */
export function formatStationTime(x: number): string {
  const v = Math.max(0, Number.isFinite(x) ? x : 0)
  let cs = Math.round(v * 100)
  const m = Math.floor(cs / 6000)
  cs -= m * 6000
  const s = (cs / 100).toFixed(2)
  return `${m}:${s.length < 5 ? `0${s}` : s}`
}

/** A length: "0.90 s". */
export function formatStationLength(x: number): string {
  return `${Math.max(0, x).toFixed(2)} s`
}

/**
 * What someone typed, as seconds rounded to 0.01: "1:02.35", "62.35",
 * "0:04.2" and "4.2" all read. Null when it isn't a time.
 */
export function parseStationTime(input: string): number | null {
  const t = String(input ?? "").trim()
  const m = t.match(/^(?:(\d+):)?(\d+(?:[.,]\d+)?)$/)
  if (!m) return null
  const secs = parseFloat(m[2].replace(",", "."))
  if (m[1] && secs >= 60) return null
  return Math.round(((m[1] ? parseInt(m[1], 10) * 60 : 0) + secs) * 100) / 100
}

/**
 * The ruler's step for a visible span (40b): 0.1 s up to 0.8 s, 0.25 up to 2,
 * 0.5 up to 5, 1 s above — and, past what the board drew, coarser steps so a
 * recording minutes long never draws a label every second.
 */
export function rulerStep(spanSec: number): number {
  if (spanSec <= 0.8) return 0.1
  if (spanSec <= 2) return 0.25
  if (spanSec <= 5) return 0.5
  if (spanSec <= 12) return 1
  if (spanSec <= 40) return 5
  if (spanSec <= 90) return 10
  if (spanSec <= 300) return 30
  return 60
}

/** The ticks between `va` and `vb`, on the ruler's step. */
export function rulerTicks(va: number, vb: number): number[] {
  const step = rulerStep(vb - va)
  const out: number[] = []
  for (let i = Math.ceil(va / step - 1e-9); i * step <= vb + 1e-6; i++) out.push(Math.round(i * step * 1000) / 1000 + 0)
  return out
}
