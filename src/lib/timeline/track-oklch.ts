// The OKLCH arithmetic behind a track's waveform and strip colours. (AQU-2235)
//
// Sam's waveform look (Oct 25, boards 51–53 of the Media Redesign canvas) gives
// every track's waveform the SAME lightness and chroma, oklch(0.55 0.14), in
// that track's own hue — so a waveform reads as equally strong in every colour
// — and every strip and dot the waveform's chroma at the track's OWN lightness.
// Both are written as CSS `oklch()`, not hex, so a wide-gamut (P3) screen shows
// the full chroma and an sRGB screen maps it down by itself. A hue that cannot
// reach 0.14 even in P3 (cyan, amber) takes its P3 maximum instead, found the
// way the canvas found it: down from the cap in 0.001 steps.
//
// The matrices are Björn Ottosson's OKLab ones, the same numbers the canvas
// generator used, so the values here are the board's to the third decimal.

export interface Oklch {
  /** Lightness, 0–1. */
  l: number
  /** Chroma. */
  c: number
  /** Hue in degrees, 0–360. */
  h: number
}

const toLinear = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)

/** `#rrggbb` → OKLCH. */
export function hexToOklch(hex: string): Oklch {
  const n = Number.parseInt(hex.replace(/^#/, ""), 16)
  const r = toLinear(((n >> 16) & 0xff) / 255)
  const g = toLinear(((n >> 8) & 0xff) / 255)
  const b = toLinear((n & 0xff) / 255)
  const cube = (v: number) => Math.sign(v) * Math.abs(v) ** (1 / 3)
  const l_ = cube(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m_ = cube(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s_ = cube(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 }
}

/** OKLCH → linear LMS, the step both gamut tests share. */
function lms(L: number, C: number, hDeg: number): [number, number, number] {
  const hr = (hDeg * Math.PI) / 180
  const A = C * Math.cos(hr)
  const B = C * Math.sin(hr)
  return [
    (L + 0.3963377774 * A + 0.2158037573 * B) ** 3,
    (L - 0.1055613458 * A - 0.0638541728 * B) ** 3,
    (L - 0.0894841775 * A - 1.291485548 * B) ** 3,
  ]
}

/** Linear LMS → linear Display P3. */
const LMS_TO_P3 = [
  [3.128110529, -2.2570750183, 0.1293047883],
  [-1.091128161, 2.4132667618, -0.3221681709],
  [-0.0260136498, -0.508027649, 1.5333166822],
] as const

const EPS = 1e-4

/** Is this colour inside the Display P3 gamut? */
export function inP3(L: number, C: number, hDeg: number): boolean {
  const v = lms(L, C, hDeg)
  return LMS_TO_P3.every((row) => {
    const x = row[0] * v[0] + row[1] * v[1] + row[2] * v[2]
    return x >= -EPS && x <= 1 + EPS
  })
}

/** The largest chroma ≤ `cap` this lightness and hue reach in P3, to 0.001. */
export function maxP3Chroma(L: number, hDeg: number, cap: number): number {
  let C = cap
  while (C > 0 && !inP3(L, C, hDeg)) C -= 0.001
  return Math.round(C * 1000) / 1000
}

/** `oklch(L C h)` as CSS, at the board's precision. */
export function oklchCss(L: number, C: number, hDeg: number): string {
  return `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${hDeg.toFixed(1)})`
}

/** Every waveform's lightness and chroma cap (Sam, Oct 25). */
export const WAVE_L = 0.55
export const WAVE_C = 0.14
/** The play line: the track darkened with its hue held (board 51). */
export const LINE_KL = 0.731
export const LINE_KC = 0.617

/** A track's waveform colour: oklch(0.55 0.14 <its hue>), capped at P3. */
export function waveColorCss(hex: string): string {
  const { h } = hexToOklch(hex)
  return `oklch(0.55 ${maxP3Chroma(WAVE_L, h, WAVE_C).toFixed(3)} ${h.toFixed(1)})`
}

/** A track's strip and dot: the waveform's chroma at the track's own lightness. */
export function stripColorCss(hex: string): string {
  const { l, h } = hexToOklch(hex)
  return oklchCss(l, maxP3Chroma(l, h, WAVE_C), h)
}

/** The play line over a playing waveform: the track at 0.731 L and 0.617 C. */
export function playLineColorCss(hex: string): string {
  const { l, c, h } = hexToOklch(hex)
  return oklchCss(l * LINE_KL, c * LINE_KC, h)
}
