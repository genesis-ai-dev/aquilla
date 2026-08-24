import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { exportAudioByCharacter } from "./audio-by-character"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

function cell(over: Partial<CellData>): CellData {
  return {
    id: "c", fileId: "f", original: "", translated: "", context: "", group: "",
    type: "cue", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [], ...over,
  }
}

const SETTINGS: ProjectTtsSettings = {
  voices: [{ id: "v-mary", name: "Mary", color: "#ec4899" }, { id: "v-john", name: "John" }],
  castAssignments: { c1: "v-mary", c2: "v-john" },
}

describe("exportAudioByCharacter", () => {
  it("produces a zip with one WAV per character, sanitized filenames", async () => {
    const cells = [
      cell({ id: "c1", startTime: 1, endTime: 2, selectedAudioId: "a1", attachments: { a1: { url: "frontier-audio://a1.wav", type: "audio/wav" } } }),
      cell({ id: "c2", startTime: 5, endTime: 6, selectedAudioId: "a2", attachments: { a2: { url: "frontier-audio://a2.wav", type: "audio/wav" } } }),
    ]
    const result = await exportAudioByCharacter({
      cells,
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => new Float32Array([0.1, 0.2, 0.3]),
    })
    expect(result.skipped).toBe(0)
    const zip = await JSZip.loadAsync(result.blob)
    const names = Object.keys(zip.files).sort()
    expect(names).toEqual(["swh_Mary.wav", "swh_John.wav"].sort())
  })

  it("prefers the lossless WAV sibling for generated webm clips, with fallback", async () => {
    const cells = [
      // Generated voice, compressed primary → the .wav sibling should be
      // fetched first (meeting 2026-08-05: exports are ALWAYS lossless).
      cell({
        id: "c1",
        startTime: 1,
        endTime: 2,
        selectedGeneratedVoiceAudioId: "gen-1.webm",
        attachments: { "gen-1.webm": { url: "frontier-audio://gen-1.webm", type: "audio/webm" } },
      }),
      // Mic take — webm too, but never eligible; fetched as-is.
      cell({
        id: "c2",
        startTime: 5,
        endTime: 6,
        selectedAudioId: "take-2.webm",
        attachments: { "take-2.webm": { url: "frontier-audio://take-2.webm", type: "audio/webm" } },
      }),
    ]
    const fetched: string[] = []
    const result = await exportAudioByCharacter({
      cells,
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async ({ audioId, ext }) => {
        fetched.push(`${audioId}.${ext}`)
        return new Uint8Array([1, 2, 3, 4])
      },
      decode: async () => new Float32Array([0.1]),
    })
    expect(result.skipped).toBe(0)
    expect(fetched).toEqual(["gen-1.wav", "take-2.webm"])
  })

  it("falls back to the compressed bytes when the WAV sibling is missing", async () => {
    const cells = [
      cell({
        id: "c1",
        startTime: 1,
        endTime: 2,
        selectedGeneratedVoiceAudioId: "gen-1.webm",
        attachments: { "gen-1.webm": { url: "frontier-audio://gen-1.webm", type: "audio/webm" } },
      }),
    ]
    const fetched: string[] = []
    const result = await exportAudioByCharacter({
      cells,
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async ({ audioId, ext }) => {
        fetched.push(`${audioId}.${ext}`)
        if (ext === "wav") throw Object.assign(new Error("audio not found (404)"), { status: 404 })
        return new Uint8Array([1, 2, 3, 4])
      },
      decode: async () => new Float32Array([0.1]),
    })
    expect(result.skipped).toBe(0) // a sibling miss is not a skipped clip
    expect(fetched).toEqual(["gen-1.wav", "gen-1.webm"])
  })

  it("skips characters with no audio and reports zero entries cleanly", async () => {
    const result = await exportAudioByCharacter({
      cells: [cell({ id: "c1" })],
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async () => new Uint8Array(),
      decode: async () => new Float32Array(),
    })
    expect(result.skipped).toBe(0)
    const zip = await JSZip.loadAsync(result.blob)
    expect(Object.keys(zip.files)).toHaveLength(0)
  })
})

// ── Counting what came out ───────────────────────────────────────────────
//
// An empty JSZip still generates a perfectly valid archive — 22 bytes — and
// handing one to someone as a download reads as success. Episode 302's export
// did exactly that, and the cause turned out to be upstream (it was fed the
// subtitle rows, which carry no audio, instead of the cue cells where takes
// live). The counts let the caller refuse instead of downloading nothing.

describe("saying what actually came out", () => {
  it("reports zero characters and zero clips when no cell has audio", async () => {
    const result = await exportAudioByCharacter({
      cells: [cell({ id: "c1" }), cell({ id: "c2" })],
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => new Float32Array([0.1]),
    })
    expect(result.clips).toBe(0)
    expect(result.characters).toBe(0)
    // …and the blob is still a real, and entirely empty, archive.
    expect(Object.keys((await JSZip.loadAsync(result.blob)).files)).toEqual([])
  })

  it("distinguishes 'nothing to export' from 'everything failed to decode'", async () => {
    const result = await exportAudioByCharacter({
      cells: [
        cell({ id: "c1", startTime: 1, endTime: 2, selectedAudioId: "a1", attachments: { a1: { url: "frontier-audio://a1.wav", type: "audio/wav" } } }),
      ],
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async () => { throw new Error("gone") },
      decode: async () => new Float32Array([0.1]),
    })
    // There WAS something to export; it just could not be read.
    expect(result.clips).toBe(1)
    expect(result.characters).toBe(0)
    expect(result.skipped).toBe(1)
  })

  it("counts the characters it actually wrote", async () => {
    const result = await exportAudioByCharacter({
      cells: [
        cell({ id: "c1", startTime: 1, endTime: 2, selectedAudioId: "a1", attachments: { a1: { url: "frontier-audio://a1.wav", type: "audio/wav" } } }),
        cell({ id: "c2", startTime: 5, endTime: 6, selectedAudioId: "a2", attachments: { a2: { url: "frontier-audio://a2.wav", type: "audio/wav" } } }),
      ],
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => new Float32Array([0.1]),
    })
    expect(result.characters).toBe(2)
    expect(result.clips).toBe(2)
  })

  it("names the files by the RESOLVED character, not the voice", async () => {
    const result = await exportAudioByCharacter({
      cells: [
        cell({ id: "c1", startTime: 1, endTime: 2, selectedAudioId: "a1", attachments: { a1: { url: "frontier-audio://a1.wav", type: "audio/wav" } } }),
      ],
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      resolveName: () => "MARY MAGDALENE'S FATHER",
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => new Float32Array([0.1]),
    })
    const names = Object.keys((await JSZip.loadAsync(result.blob)).files)
    // …sanitized for the filesystem, but recognisably the character.
    expect(names).toEqual(["swh_MARY_MAGDALENE_S_FATHER.wav"])
  })
})

// ── The zip is a DAW deliverable, not a scrapbook (2026-08-18) ────────────
//
// These read the bytes back out of the archive, because the whole complaint
// about the old export was invisible from its counts: it wrote a WAV per
// character and reported success, and what was inside was every take glued
// together with the timing thrown away.

/** Pull one entry out of the zip and read its RIFF header + samples. */
async function readWav(blob: Blob, name: string) {
  const zip = await JSZip.loadAsync(blob)
  const file = zip.file(name)
  if (!file) throw new Error(`no entry ${name} in ${Object.keys(zip.files).join(", ")}`)
  const bytes = await file.async("uint8array")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sampleRate = view.getUint32(24, true)
  const dataBytes = view.getUint32(40, true)
  const samples = new Int16Array(bytes.buffer.slice(bytes.byteOffset + 44, bytes.byteOffset + 44 + dataBytes))
  return { sampleRate, samples }
}

const RATE = 48000

describe("what is actually inside the zip", () => {
  const timed = (id: string, startTime: number, endTime: number) =>
    cell({
      id,
      startTime,
      endTime,
      selectedAudioId: `a-${id}`,
      attachments: { [`a-${id}`]: { url: `frontier-audio://a-${id}.wav`, type: "audio/wav" } },
    })

  /** One second of full-scale tone, so its position is unmistakable. */
  const oneSecond = () => new Float32Array(RATE).fill(1)

  it("places each take at its own second, on silence, from 0:00", async () => {
    const result = await exportAudioByCharacter({
      cells: [timed("c1", 10, 11)],
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => oneSecond(),
      resolveName: () => "JESUS",
    })
    const { sampleRate, samples } = await readWav(result.blob, "swh_JESUS.wav")
    expect(sampleRate).toBe(RATE)
    // Ten seconds of silence, then the line — not a file that opens with it.
    expect(samples[0]).toBe(0)
    expect(samples[RATE * 10 - 1]).toBe(0)
    expect(samples[RATE * 10]).toBe(32767)
    expect(samples[RATE * 11 - 1]).toBe(32767)
    // …and it stops just after, rather than running to the end of the episode.
    expect(samples[RATE * 11]).toBe(0)
    expect(samples.length).toBe(RATE * 11 + RATE * 0.25)
  })

  it("gives two characters tracks that line up with each other", async () => {
    // Drop both onto adjacent DAW tracks and the conversation is intact.
    const result = await exportAudioByCharacter({
      cells: [timed("c1", 2, 3), timed("c2", 30, 31)],
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => oneSecond(),
      resolveName: (c) => (c.id === "c1" ? "JESUS" : "THOMAS"),
    })
    const jesus = await readWav(result.blob, "swh_JESUS.wav")
    const thomas = await readWav(result.blob, "swh_THOMAS.wav")
    expect(jesus.samples[RATE * 2]).toBe(32767)
    expect(thomas.samples[RATE * 30]).toBe(32767)
    // Thomas's file still begins at 0:00 — it is silence up to his line.
    expect(thomas.samples[0]).toBe(0)
    expect(thomas.samples[RATE * 2]).toBe(0)
  })

  it("names entries by episode, language and character", async () => {
    const result = await exportAudioByCharacter({
      cells: [timed("c1", 1, 2)],
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fileBase: "The Chosen 101",
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => new Float32Array([0.5]),
      resolveName: () => "JESUS",
    })
    expect(Object.keys((await JSZip.loadAsync(result.blob)).files)).toEqual([
      "The_Chosen_101_swh_JESUS.wav",
    ])
  })

  it("counts a take with no timing as unplaceable rather than exporting it wrong", async () => {
    // The old export glued it on the end, which put words somewhere they were
    // never spoken. There is nowhere honest to put it, so it is reported.
    const result = await exportAudioByCharacter({
      cells: [
        timed("c1", 5, 6),
        cell({
          id: "c2",
          selectedAudioId: "a-c2",
          attachments: { "a-c2": { url: "frontier-audio://a-c2.wav", type: "audio/wav" } },
        }),
      ],
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => oneSecond(),
      resolveName: () => "JESUS",
    })
    expect(result.untimed).toBe(1)
    const { samples } = await readWav(result.blob, "swh_JESUS.wav")
    // Only the timed line is in there: 6s + pad, not 7s of audio.
    expect(samples.length).toBe(RATE * 6 + RATE * 0.25)
  })

  it("places a take shared by several lines ONCE, at the earliest of them", async () => {
    // A combined "voice together" clip hangs off every cell it covers. The old
    // export concatenated it once per cell; placed on a timeline that would be
    // three copies stacked on themselves, three times too loud.
    const shared = { url: "frontier-audio://combined.wav", type: "audio/wav" }
    const decodes: number[] = []
    const result = await exportAudioByCharacter({
      cells: [
        cell({ id: "c1", startTime: 20, endTime: 21, selectedAudioId: "combined", attachments: { combined: shared } }),
        cell({ id: "c2", startTime: 12, endTime: 13, selectedAudioId: "combined", attachments: { combined: shared } }),
      ],
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => { decodes.push(1); return oneSecond() },
      resolveName: () => "CROWD",
    })
    expect(decodes).toHaveLength(1) // fetched and decoded once, as before
    const { samples } = await readWav(result.blob, "swh_CROWD.wav")
    expect(samples[RATE * 12]).toBe(32767) // the earliest covering cue
    expect(samples[RATE * 20]).toBe(0)     // NOT a second copy
    expect(samples[RATE * 12]).toBe(32767) // and not doubled in amplitude
  })
})
