// AQU-2664: an evened-out take comes out of every export at the target, by
// the same rule the mixer plays it at (lib/audio/take-gain.ts). Measured on
// the exported WAV with the app's own meter.
import { describe, expect, it } from "vitest"
import JSZip from "jszip"
import { exportAudioByChapter } from "./audio-chapter"
import { exportAudioByCharacter } from "./audio-by-character"
import { exportAudioPerLine } from "./audio-per-line"
import { measureLoudness } from "@/lib/audio/loudness"
import { TARGET_RATE } from "@/lib/audio/decode-mono"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

const SETTINGS: ProjectTtsSettings = { voices: [{ id: "v-mary", name: "Mary" }], castAssignments: {} }

/** A mono 1 kHz sine whose loudness is `lufs`, `seconds` long, at 48 kHz. */
function sineAt(lufs: number, seconds = 3): Float32Array {
  const a = Math.pow(10, (lufs + 10 * Math.log10(2)) / 20)
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
})
