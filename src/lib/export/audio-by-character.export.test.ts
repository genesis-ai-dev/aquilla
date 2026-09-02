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

  // ── The mix contains what you hear (Sam, 2026-08-27) ─────────────────────
  //
  // `startSec` is the take's AUDIBLE start — anchor plus head trim — so laying
  // the whole recording there put every take late by exactly its head trim,
  // with the trimmed material audible in front of it. `take-margins.ts` gives
  // every recorded take one at birth, so this was nearly every take in the
  // deliverable, and no fixture in this file set a trim before today.
  it("lays only the audible part of a trimmed take, at the second the timeline draws it", async () => {
    const trimmedCell = cell({
      id: "c1", startTime: 10, endTime: 12,
      selectedAudioId: "a1",
      attachments: {
        // A one-second clip, of which the middle half second is audible.
        a1: { url: "frontier-audio://a1.wav", type: "audio/wav", durationMs: 1000, trimStartMs: 250, trimEndMs: 750 },
      },
    })
    const result = await exportAudioByCharacter({
      cells: [trimmedCell], settings: SETTINGS, projectId: "p1", langCode: "swh",
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      // Ramp, so which slice landed is identifiable rather than just its length.
      decode: async () => Float32Array.from({ length: RATE }, (_, i) => i / RATE),
      resolveName: () => "PETER",
    })
    const { samples } = await readWav(result.blob, "swh_PETER.wav")
    // Audible from 10.25s (anchor 10 + 250 ms head trim) …
    expect(samples[RATE * 10 + RATE * 0.25 - 1]).toBe(0)
    expect(samples[RATE * 10 + RATE * 0.25]).toBeGreaterThan(0)
    // …and the first sample laid is the one at 250 ms into the clip, not 0.
    expect(samples[RATE * 10 + RATE * 0.25]).toBeCloseTo(Math.round(0.25 * 32767), -2)
    // …for half a second, then silence.
    expect(samples[RATE * 10 + RATE * 0.74]).toBeGreaterThan(0)
    expect(samples[RATE * 10 + RATE * 0.76] ?? 0).toBe(0)
  })

  // The other half of the same change: two cells CAN share one audio id and
  // still be different audio, because an imported file is split per cue by
  // giving each cell its own window into it (`attach-media.ts`). Collapsing
  // those exported one cue's slice for all of them.
  it("keeps two slices of one imported clip apart", async () => {
    const shared = (trimStartMs: number, trimEndMs: number) => ({
      url: "frontier-audio://import.wav", type: "audio/wav", durationMs: 1000, trimStartMs, trimEndMs,
    })
    const decodes: number[] = []
    const result = await exportAudioByCharacter({
      cells: [
        cell({ id: "c1", startTime: 5, endTime: 6, selectedAudioId: "import", attachments: { import: shared(0, 250) } }),
        cell({ id: "c2", startTime: 30, endTime: 31, selectedAudioId: "import", attachments: { import: shared(750, 1000) } }),
      ],
      settings: SETTINGS, projectId: "p1", langCode: "swh",
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => { decodes.push(1); return new Float32Array(RATE).fill(1) },
      resolveName: () => "CROWD",
    })
    // Still ONE fetch and decode — the cache is keyed on the audio id.
    expect(decodes).toHaveLength(1)
    const { samples } = await readWav(result.blob, "swh_CROWD.wav")
    // But TWO placements, each a quarter second long, at their own cues.
    expect(samples[RATE * 5]).toBe(32767)
    expect(samples[RATE * 5 + RATE * 0.3] ?? 0).toBe(0)
    expect(samples[RATE * 30 + RATE * 0.75]).toBe(32767)
  })

  // ── How long a character's track runs (Sam, 2026-08-27) ──────────────────
  //
  // "Whichever is longest": the later of where the audio stops and where the
  // last line that character speaks was supposed to end. The first half is
  // computed from the placed audio; the second was being fed the TAKE's own
  // audible end rather than the CUE's window, so the comparison compared a
  // number with itself. Nothing distinguished the two until these.
  const trackSeconds = (samples: Int16Array) => samples.length / RATE

  it("runs to the end of the LINE when the take stops short of it", async () => {
    // A one-second take on a four-second line. The track should hold the line,
    // not stop a moment after the voice does.
    const short = cell({
      id: "c1", startTime: 10, endTime: 14,
      selectedAudioId: "a1",
      attachments: { a1: { url: "frontier-audio://a1.wav", type: "audio/wav", durationMs: 1000 } },
    })
    const result = await exportAudioByCharacter({
      cells: [short], settings: SETTINGS, projectId: "p1", langCode: "swh",
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => new Float32Array(RATE).fill(1),
      resolveName: () => "PETER",
    })
    const { samples } = await readWav(result.blob, "swh_PETER.wav")
    // 14s of line + the tail pad — NOT 11s, which is where the audio stops.
    expect(trackSeconds(samples)).toBeCloseTo(14.25, 2)
  })

  it("runs to the end of the AUDIO when a take overruns its line", async () => {
    const overrun = cell({
      id: "c1", startTime: 10, endTime: 11,
      selectedAudioId: "a1",
      attachments: { a1: { url: "frontier-audio://a1.wav", type: "audio/wav", durationMs: 3000 } },
    })
    const result = await exportAudioByCharacter({
      cells: [overrun], settings: SETTINGS, projectId: "p1", langCode: "swh",
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => new Float32Array(RATE * 3).fill(1),
      resolveName: () => "PETER",
    })
    const { samples } = await readWav(result.blob, "swh_PETER.wav")
    // Losing recorded audio to save silence is the wrong trade in a mix.
    expect(trackSeconds(samples)).toBeCloseTo(13.25, 2)
  })

  // The case that made this worth fixing: an imported clip's trim window is an
  // offset into a long file, so the take's "audible end" can be minutes past
  // the episode. The line's window is not.
  it("does not run minutes past the episode for a cue that slices a long import", async () => {
    const sliced = cell({
      id: "c1", startTime: 5, endTime: 6,
      selectedAudioId: "a1",
      attachments: {
        a1: {
          url: "frontier-audio://import.wav", type: "audio/wav",
          durationMs: 600_000, trimStartMs: 0, trimEndMs: 600_000,
        },
      },
    })
    const result = await exportAudioByCharacter({
      cells: [sliced], settings: SETTINGS, projectId: "p1", langCode: "swh",
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => new Float32Array(RATE).fill(1),
      resolveName: () => "CROWD",
    })
    const { samples } = await readWav(result.blob, "swh_CROWD.wav")
    // Six seconds and a quarter, not ten minutes of silence.
    expect(trackSeconds(samples)).toBeCloseTo(6.25, 2)
  })

  // Two characters whose names differ only by case are two files to this
  // sanitiser and ONE file to macOS and Windows, so the second replaced the
  // first on extraction (2026-08-27). Same rule as the per-line folder names.
  it("keeps two characters apart when their names differ only by case", async () => {
    const timedFor = (id: string, at: number) =>
      cell({
        id, startTime: at, endTime: at + 1,
        selectedAudioId: `a-${id}`,
        attachments: { [`a-${id}`]: { url: `frontier-audio://a-${id}.wav`, type: "audio/wav" } },
      })
    const result = await exportAudioByCharacter({
      cells: [timedFor("c1", 5), timedFor("c2", 9)],
      settings: SETTINGS, projectId: "p1", langCode: "swh",
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => new Float32Array(RATE).fill(1),
      resolveName: (c) => (c.id === "c1" ? "Jesus" : "JESUS"),
    })
    const zip = await JSZip.loadAsync(result.blob)
    const names = Object.keys(zip.files).sort()
    expect(names).toHaveLength(2)
    // Distinct even once the filesystem folds their case.
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(2)
    expect(result.characters).toBe(2)
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
