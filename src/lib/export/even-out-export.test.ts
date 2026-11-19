// AQU-2664: an evened-out take comes out of every export at the target, by
// the same rule the mixer plays it at (lib/audio/take-gain.ts). Measured on
// the exported WAV with the app's own meter.
import { describe, expect, it } from "vitest"
import JSZip from "jszip"
import { exportAudioByChapter } from "./audio-chapter"
import { exportAudioByCharacter } from "./audio-by-character"
import { exportAudioPerLine } from "./audio-per-line"
import { measureLoudness } from "@/lib/audio/loudness"
import { takeGain } from "@/lib/audio/take-gain"
import { applyClipLevelPcm, levelFields } from "./clip-level"
import { withTrackVolumes } from "@/lib/audio/track-volume"
import { withMonoLoudness } from "./mono-loudness"
import { TARGET_RATE } from "@/lib/audio/decode-mono"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

const SETTINGS: ProjectTtsSettings = { voices: [{ id: "v-mary", name: "Mary" }], castAssignments: {} }

/** A mono 1 kHz sine whose loudness is `lufs` as heard (dual mono: its
 *  peak in dBFS), `seconds` long, at 48 kHz. */
function sineAt(lufs: number, seconds = 3): Float32Array {
  const a = Math.pow(10, lufs / 20)
  const out = new Float32Array(Math.round(seconds * TARGET_RATE))
  for (let i = 0; i < out.length; i++) out[i] = a * Math.sin((2 * Math.PI * 1000 * i) / TARGET_RATE)
  return out
}

const QUIET = -26
const LOUD = -10
const pcmOf: Record<string, Float32Array> = { quiet: sineAt(QUIET), loud: sineAt(LOUD) }
const reading = (lufs: number) => measureLoudness([sineAt(lufs)], TARGET_RATE)

function cell(id: string, take: "quiet" | "loud", at: number, even: boolean, type = "cue"): CellData {
  const r = reading(take === "quiet" ? QUIET : LOUD)
  return {
    id, fileId: "f1", original: "", translated: "", context: "", group: "MAT 1:" + at,
    type, status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [],
    startTime: at, endTime: at + 3,
    selectedAudioId: `${take}-${id}`,
    attachments: {
      [`${take}-${id}`]: {
        url: `frontier-audio://${take}-${id}.wav`, type: "audio",
        durationMs: 3000,
        loudnessLufs: r.integratedLufs, truePeakDb: r.truePeakDb,
        ...(even ? { evenTargetLufs: -16 } : {}),
      },
    },
  } as unknown as CellData
}

const fetchBytes = async ({ audioId }: { audioId: string }) => new TextEncoder().encode(audioId)
const decode = async (bytes: Uint8Array) => pcmOf[new TextDecoder().decode(bytes).split("-")[0]]

/** The samples of a 16-bit mono WAV, as floats. */
async function samplesOf(bytes: Uint8Array): Promise<Float32Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let o = 12
  while (String.fromCharCode(...bytes.subarray(o, o + 4)) !== "data") o += 8 + view.getUint32(o + 4, true)
  const n = view.getUint32(o + 4, true) / 2
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = view.getInt16(o + 8 + i * 2, true) / 32767
  return out
}
const lufs = async (bytes: Uint8Array) => measureLoudness([await samplesOf(bytes)], TARGET_RATE).integratedLufs

describe("an evened-out take in an export", () => {
  it("by line, as WAV: each take at -16 LUFS; a take not evened out as recorded", async () => {
    const result = await exportAudioPerLine({
      cells: [cell("c1", "quiet", 10, true), cell("c2", "loud", 20, true), cell("c3", "quiet", 30, false)],
      settings: SETTINGS, projectId: "p1", langCode: "es",
      format: "wav", decode, fetchBytes,
    })
    const zip = await JSZip.loadAsync(result.blob)
    const names = Object.keys(zip.files).filter((n) => n.endsWith(".wav")).sort()
    expect(names).toHaveLength(3)
    const [a, b, c] = await Promise.all(names.map(async (n) => lufs(await zip.files[n].async("uint8array"))))
    expect(Math.abs(a - -16)).toBeLessThan(0.5)
    expect(Math.abs(b - -16)).toBeLessThan(0.5)
    expect(Math.abs(c - QUIET)).toBeLessThan(0.5)
  })

  it("by line, as original files: an evened-out take is written as WAV at the target", async () => {
    const result = await exportAudioPerLine({
      cells: [cell("c1", "quiet", 10, true)],
      settings: SETTINGS, projectId: "p1", langCode: "es",
      format: "original", decode, fetchBytes,
    })
    const zip = await JSZip.loadAsync(result.blob)
    const [name] = Object.keys(zip.files).filter((n) => n.endsWith(".wav"))
    expect(name).toBeTruthy()
    expect(Math.abs((await lufs(await zip.files[name].async("uint8array"))) - -16)).toBeLessThan(0.5)
  })

  it("by chapter: the joined verses are all at -16 LUFS", async () => {
    const result = await exportAudioByChapter({
      cells: [cell("v1", "quiet", 1, true, "verse"), cell("v2", "loud", 2, true, "verse")],
      projectId: "p1", fetchBytes, decode,
    })
    const all = await samplesOf(new Uint8Array(await result.blob.arrayBuffer()))
    const half = all.length / 2
    expect(Math.abs(measureLoudness([all.subarray(0, half)], TARGET_RATE).integratedLufs - -16)).toBeLessThan(0.5)
    expect(Math.abs(measureLoudness([all.subarray(half)], TARGET_RATE).integratedLufs - -16)).toBeLessThan(0.5)
  })

  it("by character: the stem holding a quiet and a loud take reads -16 LUFS", async () => {
    const result = await exportAudioByCharacter({
      cells: [cell("c1", "quiet", 1, true), cell("c2", "loud", 5, true)],
      settings: SETTINGS, projectId: "p1", langCode: "es", fetchBytes, decode,
    })
    const zip = await JSZip.loadAsync(result.blob)
    const [name] = Object.keys(zip.files).filter((n) => n.endsWith(".wav"))
    expect(Math.abs((await lufs(await zip.files[name].async("uint8array"))) - -16)).toBeLessThan(0.5)
  })

  // Sam, Nov 19: mono is measured as heard (dual mono), so a mono voice and a
  // stereo take of the same sound end up at the same heard level.
  it("a mono take and a stereo take of the same sound even out to the same heard level", () => {
    const sound = sineAt(-27, 3)
    const monoR = measureLoudness([sound], TARGET_RATE)
    const stereoR = measureLoudness([sound, sound], TARGET_RATE)
    const fields = (r: typeof monoR) => ({ loudnessLufs: r.integratedLufs, truePeakDb: r.truePeakDb, evenTargetLufs: -16 })
    expect(takeGain(fields(monoR)).correctionDb).toBeCloseTo(takeGain(fields(stereoR)).correctionDb, 2)
    const mono = applyClipLevelPcm(sound, TARGET_RATE, fields(monoR))
    const left = applyClipLevelPcm(sound, TARGET_RATE, fields(stereoR))
    // Heard: the mono take on both speakers; the stereo take as it is.
    const heardMono = measureLoudness([mono, mono], TARGET_RATE).integratedLufs
    const heardStereo = measureLoudness([left, left], TARGET_RATE).integratedLufs
    expect(Math.abs(heardMono - -16)).toBeLessThan(0.5)
    expect(Math.abs(heardMono - heardStereo)).toBeLessThan(0.05)
  })
})

// Review M3: a track's volume rides each clip on its own, after the take's
// evening out and own volume, in every export. −∞ is silence.
describe("a track's volume in an export (review M3)", () => {
  const silentTrack = { "target-audio": { volumeDb: "-inf" as const } }
  const downSix = { "target-audio": { volumeDb: -6 } }
  const peak = (pcm: Float32Array) => pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  /** An evened take with its own −2 dB on top. */
  const own = (c: CellData) => {
    const att = Object.values(c.attachments!)[0] as unknown as Record<string, unknown>
    att.gainDb = -2
    return c
  }

  it("by line: −∞ is silent; −6 dB lands after evening out and the take's own volume", async () => {
    for (const [overrides, expectLufs] of [[silentTrack, null], [downSix, -16 - 2 - 6]] as const) {
      const result = await exportAudioPerLine({
        cells: withTrackVolumes([own(cell("c1", "quiet", 10, true))], overrides),
        settings: SETTINGS, projectId: "p1", langCode: "es", format: "wav", decode, fetchBytes,
      })
      const zip = await JSZip.loadAsync(result.blob)
      const [name] = Object.keys(zip.files).filter((n) => n.endsWith(".wav"))
      const bytes = await zip.files[name].async("uint8array")
      if (expectLufs == null) expect(peak(await samplesOf(bytes))).toBe(0)
      else expect(Math.abs((await lufs(bytes)) - expectLufs)).toBeLessThan(0.5)
    }
  })

  it("by chapter: −∞ is silent; −6 dB lands after evening out and the take's own volume", async () => {
    for (const [overrides, expectLufs] of [[silentTrack, null], [downSix, -16 - 2 - 6]] as const) {
      const result = await exportAudioByChapter({
        cells: withTrackVolumes([own(cell("v1", "quiet", 1, true, "verse"))], overrides),
        projectId: "p1", fetchBytes, decode,
      })
      const all = await samplesOf(new Uint8Array(await result.blob.arrayBuffer()))
      if (expectLufs == null) expect(peak(all)).toBe(0)
      else expect(Math.abs(measureLoudness([all], TARGET_RATE).integratedLufs - expectLufs)).toBeLessThan(0.5)
    }
  })

  it("by character: −∞ is silent; −6 dB lands after evening out and the take's own volume", async () => {
    for (const [overrides, expectLufs] of [[silentTrack, null], [downSix, -16 - 2 - 6]] as const) {
      const result = await exportAudioByCharacter({
        cells: withTrackVolumes([own(cell("c1", "quiet", 1, true))], overrides),
        settings: SETTINGS, projectId: "p1", langCode: "es", fetchBytes, decode,
      })
      const zip = await JSZip.loadAsync(result.blob)
      const [name] = Object.keys(zip.files).filter((n) => n.endsWith(".wav"))
      const bytes = await zip.files[name].async("uint8array")
      if (expectLufs == null) expect(peak(await samplesOf(bytes))).toBe(0)
      else expect(Math.abs((await lufs(bytes)) - expectLufs)).toBeLessThan(0.5)
    }
  })

  it("keeps the two stages apart on an export's own clip record", () => {
    expect(levelFields({ gainDb: -2, trackGainDb: -Infinity })).toEqual({ gainDb: -2, trackGainDb: -Infinity, fadeInMs: null, fadeOutMs: null })
    const out = applyClipLevelPcm(new Float32Array([0.5]), TARGET_RATE, levelFields({ gainDb: -2, trackGainDb: -Infinity }))
    expect(out[0] === 0).toBe(true)
  })
})

// Sam, question 93: with "As a single-channel meter reads it", an evened
// mono take reads −16 LUFS on a meter that counts its one channel once (3 dB
// under the as-heard reading), in every path, raised exactly once.
describe("mono loudness as a meter reads it, in every export (question 93)", () => {
  const meterRead = (pcm: Float32Array) => measureLoudness([pcm], TARGET_RATE).integratedLufs - 10 * Math.log10(2)

  it("by line: −16 on a single-channel meter; a take not evened is as recorded", async () => {
    const result = await exportAudioPerLine({
      cells: withMonoLoudness([cell("c1", "quiet", 10, true), cell("c2", "quiet", 20, false)], "meter"),
      settings: SETTINGS, projectId: "p1", langCode: "es", format: "wav", decode, fetchBytes,
    })
    const zip = await JSZip.loadAsync(result.blob)
    const [a, b] = Object.keys(zip.files).filter((n) => n.endsWith(".wav")).sort()
    expect(Math.abs(meterRead(await samplesOf(await zip.files[a].async("uint8array"))) - -16)).toBeLessThan(0.5)
    expect(Math.abs((await lufs(await zip.files[b].async("uint8array"))) - QUIET)).toBeLessThan(0.5)
  })

  it("by chapter: −16 on a single-channel meter", async () => {
    const result = await exportAudioByChapter({
      cells: withMonoLoudness([cell("v1", "quiet", 1, true, "verse")], "meter"),
      projectId: "p1", fetchBytes, decode,
    })
    expect(Math.abs(meterRead(await samplesOf(new Uint8Array(await result.blob.arrayBuffer()))) - -16)).toBeLessThan(0.5)
  })

  it("by character: −16 on a single-channel meter", async () => {
    const result = await exportAudioByCharacter({
      cells: withMonoLoudness([cell("c1", "quiet", 1, true)], "meter"),
      settings: SETTINGS, projectId: "p1", langCode: "es", fetchBytes, decode,
    })
    const zip = await JSZip.loadAsync(result.blob)
    const [name] = Object.keys(zip.files).filter((n) => n.endsWith(".wav"))
    expect(Math.abs(meterRead(await samplesOf(await zip.files[name].async("uint8array"))) - -16)).toBeLessThan(0.5)
  })

  it("as heard (the default) is today's export", async () => {
    const result = await exportAudioByChapter({
      cells: withMonoLoudness([cell("v1", "quiet", 1, true, "verse")], "heard"),
      projectId: "p1", fetchBytes, decode,
    })
    expect(Math.abs(measureLoudness([await samplesOf(new Uint8Array(await result.blob.arrayBuffer()))], TARGET_RATE).integratedLufs - -16)).toBeLessThan(0.5)
  })
})
