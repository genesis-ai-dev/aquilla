/**
 * synth-audio — code-synthesized trailer score, zero dependencies.
 *
 * Writes a 16-bit PCM WAV by computing every sample as a function of time, so
 * the bed is fully deterministic and rights-clean (no stock music). The score
 * is a small cinematic kit:
 *   - a sub heartbeat (lub-dub) that anchors the tension,
 *   - a slow swelling pad chord (the "promise"),
 *   - a noise riser into the final beat,
 *   - a low impact + shimmer on the CTA.
 *
 * The arrangement is driven by the same beat grid the visual composition uses
 * (see compose.html / promo.config.ts), so audio hits land on the cuts.
 */
import { writeFileSync } from "node:fs"

const SAMPLE_RATE = 48_000

export interface TrailerBeat {
  /** seconds from start */
  t: number
  /** "thump" heartbeat accent · "swell" pad lift · "impact" final hit */
  kind: "thump" | "swell" | "impact"
}

export interface AudioOpts {
  durationSec: number
  /** Beat grid shared with the visual composition. */
  beats: TrailerBeat[]
}

const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x))
/** smoothstep 0→1 over [a,b] */
const ramp = (x: number, a: number, b: number) => {
  if (x <= a) return 0
  if (x >= b) return 1
  const u = (x - a) / (b - a)
  return u * u * (3 - 2 * u)
}

/** Deterministic value-noise in [-1,1] (no Math.random — reproducible). */
function noise(t: number): number {
  const s = Math.sin(t * 12_193.17) * 43_758.545
  return (s - Math.floor(s)) * 2 - 1
}

/** One heartbeat (lub-dub): two damped sub sines a beat apart. */
function heartbeat(dt: number): number {
  if (dt < 0) return 0
  const thump = (off: number, gain: number) => {
    const d = dt - off
    if (d < 0) return 0
    const env = Math.exp(-d * 18)
    return Math.sin(2 * Math.PI * 54 * d) * env * gain
  }
  return thump(0, 1) + thump(0.18, 0.7)
}

/** A swelling chord: detuned sines on A2/E3/A3 with a slow attack. */
function pad(t: number, dur: number): number {
  const freqs = [110, 164.81, 220]
  const attack = ramp(t, 0.4, dur * 0.55)
  const release = 1 - ramp(t, dur - 1.4, dur)
  let s = 0
  for (const f of freqs) {
    s += Math.sin(2 * Math.PI * f * t)
    s += Math.sin(2 * Math.PI * f * 1.003 * t) * 0.6 // detune shimmer
  }
  return (s / 5) * attack * release
}

/** Filtered-noise riser into a target time. */
function riser(t: number, target: number): number {
  const lead = 3.2
  const u = ramp(t, target - lead, target)
  if (u <= 0) return 0
  // brighten + load as it approaches the hit
  const tone = Math.sin(2 * Math.PI * (200 + 1400 * u) * t)
  const air = noise(t * (1 + 6 * u))
  return (tone * 0.4 + air * 0.6) * u * u
}

/** Low impact boom + bright shimmer at a beat. */
function impact(dt: number): number {
  if (dt < 0) return 0
  const boom = Math.sin(2 * Math.PI * 48 * dt) * Math.exp(-dt * 6)
  const body = Math.sin(2 * Math.PI * 90 * dt) * Math.exp(-dt * 9) * 0.5
  const shimmer = noise(dt * 9000) * Math.exp(-dt * 7) * 0.4
  return boom + body + shimmer
}

/** Build the stereo sample buffer for the score. */
export function renderTrailerAudio(opts: AudioOpts): Buffer {
  const { durationSec, beats } = opts
  const n = Math.floor(durationSec * SAMPLE_RATE)
  const buf = Buffer.alloc(n * 2 * 2) // 16-bit, stereo

  const impactTimes = beats.filter((b) => b.kind === "impact").map((b) => b.t)
  const thumpTimes = beats.filter((b) => b.kind === "thump").map((b) => b.t)
  const lastImpact = impactTimes.length ? impactTimes[impactTimes.length - 1] : durationSec - 0.6

  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE
    let s = 0
    s += pad(t, durationSec) * 0.5
    for (const bt of thumpTimes) s += heartbeat(t - bt) * 0.6
    // also a steady heartbeat pulse through the body for continuity
    s += heartbeat((t % 1.5)) * 0.18 * ramp(t, 0.5, 2.5) * (1 - ramp(t, durationSec - 2, durationSec))
    s += riser(t, lastImpact) * 0.45
    for (const it of impactTimes) s += impact(t - it) * 0.9

    // master: soft saturation + gentle fade in/out
    const fade = ramp(t, 0, 0.4) * (1 - ramp(t, durationSec - 0.5, durationSec))
    s = Math.tanh(s * 1.1) * 0.86 * fade
    const v = clamp(s)
    const int16 = (v * 32_767) | 0
    const off = i * 4
    buf.writeInt16LE(int16, off)
    buf.writeInt16LE(int16, off + 2)
  }
  return buf
}

/** Wrap PCM samples in a WAV container and write to disk. */
export function writeWav(path: string, samples: Buffer): void {
  const header = Buffer.alloc(44)
  const dataLen = samples.length
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + dataLen, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16) // PCM chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(2, 22) // stereo
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * 2 * 2, 28) // byte rate
  header.writeUInt16LE(2 * 2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write("data", 36)
  header.writeUInt32LE(dataLen, 40)
  writeFileSync(path, Buffer.concat([header, samples]))
}
