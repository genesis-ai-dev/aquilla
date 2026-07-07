/**
 * synth-audio — code-synthesized trailer score, zero dependencies.
 *
 * Writes a 16-bit PCM WAV by computing every sample as a function of time, so
 * the bed is fully deterministic and rights-clean (no stock music). The score
 * is a small cinematic kit whose arrangement follows the beat grid the visual
 * composition uses (promo.config.ts), so hits land on the cuts:
 *   - a sub heartbeat (lub-dub) that anchors the tension,
 *   - a swelling pad CHORD that progresses (tension → resolution),
 *   - a noise riser into the final beat,
 *   - a low impact, then a RESOLVE tail (chord lift + bell arpeggio + shimmer)
 *     so the ending evolves instead of sitting on a static drone.
 *
 * `mood` lets each persona's trailer feel different from the same engine:
 *   - "build"    confident, forward-leaning, resolves upward (e.g. the manager)
 *   - "intimate" warm, close, gentle resolution (e.g. the translator)
 *   - "epic"     wider, brighter pad + stronger impact (hero launch)
 */
import { writeFileSync } from "node:fs"

const SAMPLE_RATE = 48_000

export type Mood = "build" | "intimate" | "epic"

export interface TrailerBeat {
  /** seconds from start */
  t: number
  /** "thump" heartbeat accent · "swell" pad lift · "impact" final hit */
  kind: "thump" | "swell" | "impact"
}

export interface AudioOpts {
  durationSec: number
  beats: TrailerBeat[]
  mood?: Mood
}

const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x))
/** smoothstep 0→1 over [a,b] */
const ramp = (x: number, a: number, b: number) => {
  if (x <= a) return 0
  if (x >= b) return 1
  const u = (x - a) / (b - a)
  return u * u * (3 - 2 * u)
}
const lerp = (a: number, b: number, u: number) => a + (b - a) * u

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

// Mood → musical character. Chords are root-frequency sets (Hz).
const MOOD: Record<Mood, { tense: number[]; resolved: number[]; bright: number; impact: number }> = {
  // Asus → A major lift
  build: { tense: [110, 146.83, 220], resolved: [110, 164.81, 220, 277.18], bright: 1, impact: 0.95 },
  // softer, closer voicing; minor-add → warm major
  intimate: { tense: [98, 146.83, 196], resolved: [98, 164.81, 196, 246.94], bright: 0.7, impact: 0.7 },
  // wide, cinematic
  epic: { tense: [82.41, 123.47, 164.81], resolved: [82.41, 130.81, 196, 329.63], bright: 1.2, impact: 1.15 },
}

/** Swelling pad whose chord progresses from a "tense" voicing to a "resolved"
 *  one over the back half — plus a gentle tremolo so it never sits dead. */
function pad(t: number, dur: number, mood: Mood): number {
  const m = MOOD[mood]
  const prog = ramp(t, dur * 0.45, dur * 0.86) // tense → resolved
  const attack = ramp(t, 0.4, dur * 0.5)
  const release = 1 - ramp(t, dur - 1.0, dur)
  const tremolo = 0.9 + 0.1 * Math.sin(2 * Math.PI * 0.7 * t) // subtle life
  let s = 0
  let n = 0
  const voices = Math.max(m.tense.length, m.resolved.length)
  for (let i = 0; i < voices; i++) {
    const fa = m.tense[i] ?? m.tense[m.tense.length - 1]
    const fb = m.resolved[i] ?? m.resolved[m.resolved.length - 1]
    const f = lerp(fa, fb, prog)
    s += Math.sin(2 * Math.PI * f * t)
    s += Math.sin(2 * Math.PI * f * 1.003 * t) * 0.5 // detune shimmer
    n += 1.5
  }
  return (s / n) * attack * release * tremolo
}

/** Filtered-noise riser into a target time. */
function riser(t: number, target: number): number {
  const lead = 3.2
  const u = ramp(t, target - lead, target)
  if (u <= 0) return 0
  const tone = Math.sin(2 * Math.PI * (200 + 1400 * u) * t)
  const air = noise(t * (1 + 6 * u))
  return (tone * 0.4 + air * 0.6) * u * u
}

/** Low impact boom + bright shimmer at a beat. */
function impact(dt: number, gain: number): number {
  if (dt < 0) return 0
  const boom = Math.sin(2 * Math.PI * 48 * dt) * Math.exp(-dt * 6)
  const body = Math.sin(2 * Math.PI * 90 * dt) * Math.exp(-dt * 9) * 0.5
  const shimmer = noise(dt * 9000) * Math.exp(-dt * 7) * 0.4
  return (boom + body + shimmer) * gain
}

/** Resolve tail: a bell/celesta arpeggio over the resolved chord after the
 *  final impact, so the last few seconds keep moving and land warm. */
function resolveTail(t: number, impactT: number, dur: number, mood: Mood): number {
  if (t < impactT) return 0
  const m = MOOD[mood]
  // arpeggiate the resolved chord, two octaves up, one note every ~0.42s
  const notes = m.resolved.map((f) => f * 4)
  const step = 0.42
  let s = 0
  for (let i = 0; i < notes.length + 2; i++) {
    const onset = impactT + 0.12 + i * step
    const d = t - onset
    if (d < 0 || d > 2.2) continue
    const f = notes[i % notes.length] * (i >= notes.length ? 1.5 : 1)
    // bell = fundamental + inharmonic partial, fast attack, long decay
    const env = Math.exp(-d * 2.6)
    const bell = (Math.sin(2 * Math.PI * f * d) + 0.4 * Math.sin(2 * Math.PI * f * 2.76 * d)) * env
    s += bell
  }
  const tailFade = 1 - ramp(t, dur - 0.8, dur)
  return s * 0.16 * m.bright * tailFade
}

/** Build the stereo sample buffer for the score. */
export function renderTrailerAudio(opts: AudioOpts): Buffer {
  const { durationSec, beats } = opts
  const mood: Mood = opts.mood ?? "build"
  const m = MOOD[mood]
  const n = Math.floor(durationSec * SAMPLE_RATE)
  const buf = Buffer.alloc(n * 2 * 2) // 16-bit, stereo

  const impactTimes = beats.filter((b) => b.kind === "impact").map((b) => b.t)
  const thumpTimes = beats.filter((b) => b.kind === "thump").map((b) => b.t)
  const lastImpact = impactTimes.length ? impactTimes[impactTimes.length - 1] : durationSec - 3.0

  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE
    let s = 0
    s += pad(t, durationSec, mood) * 0.5
    for (const bt of thumpTimes) s += heartbeat(t - bt) * 0.6
    // steady heartbeat pulse through the BODY only — it stops before the
    // resolve so the ending breathes instead of thudding mechanically.
    s += heartbeat(t % 1.5) * 0.18 * ramp(t, 0.5, 2.5) * (1 - ramp(t, lastImpact - 1.2, lastImpact))
    s += riser(t, lastImpact) * 0.45
    for (const it of impactTimes) s += impact(t - it, m.impact) * 0.9
    s += resolveTail(t, lastImpact, durationSec, mood)

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
