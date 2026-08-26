// One file per recording, carrying its own timing. (AQU-646, 2026-08-18)
//
// The second of codex-editor's two audio shapes. The character export is for
// whoever mixes the episode; this is for whoever reviews it — and the thing it
// must never do is hand over a folder of audio that has forgotten where any of
// it belongs.

import { describe, expect, it } from "vitest"
import JSZip from "jszip"

import {
  buildManifestCsv,
  collectPerLineClips,
  exportAudioPerLine,
  perLineFileName,
  timecode,
  trackFolderNames,
} from "./audio-per-line"
import { buildBextPayload, withBwfTimestamp } from "./audio-bwf"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"
import type { TimelineTrack } from "@/lib/timeline/tracks"

const SETTINGS: ProjectTtsSettings = {
  voices: [{ id: "v-mary", name: "Mary" }],
  castAssignments: {},
}

function cell(over: Partial<CellData>): CellData {
  return {
    id: "c", fileId: "f1", original: "", translated: "", context: "", group: "",
    type: "cue", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [], ...over,
  } as CellData
}

const withTake = (id: string, startTime: number, ext = "wav") =>
  cell({
    id,
    startTime,
    endTime: startTime + 1,
    selectedAudioId: `a-${id}`,
    attachments: { [`a-${id}`]: { url: `frontier-audio://a-${id}.${ext}`, type: "audio" } },
  })

/** A minimal but real RIFF/WAVE: header, `fmt `, `data`. */
function makeWav(dataBytes = 8): Uint8Array {
  const bytes = new Uint8Array(12 + 8 + 16 + 8 + dataBytes)
  const view = new DataView(bytes.buffer)
  const tag = (at: number, s: string) => { for (let i = 0; i < 4; i += 1) view.setUint8(at + i, s.charCodeAt(i)) }
  tag(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); tag(8, "WAVE")
  tag(12, "fmt "); view.setUint32(16, 16, true)
  tag(36, "data"); view.setUint32(40, dataBytes, true)
  for (let i = 0; i < dataBytes; i += 1) view.setUint8(44 + i, i + 1)
  return bytes
}

describe("numbering the lines", () => {
  it("counts every line, not just the recorded ones", () => {
    // L003 has to mean the third line of the episode in both of two exports
    // taken a week apart, whatever got recorded in between.
    const clips = collectPerLineClips(
      [withTake("c1", 10), cell({ id: "c2", startTime: 20 }), withTake("c3", 30)],
      SETTINGS,
    )
    expect(clips.map((c) => c.lineNumber)).toEqual([1, 3])
  })

  it("numbers in the order the lines are heard, not the order they arrive", () => {
    const clips = collectPerLineClips([withTake("late", 90), withTake("early", 5)], SETTINGS)
    expect(clips.map((c) => c.cellId)).toEqual(["early", "late"])
    expect(clips.map((c) => c.lineNumber)).toEqual([1, 2])
  })

  it("keeps an untimed recording, at the end, rather than dropping it", () => {
    // It cannot be placed, but it exists and somebody recorded it.
    const clips = collectPerLineClips([withTake("c1", 10), withTake("loose", NaN)], SETTINGS)
    expect(clips).toHaveLength(2)
  })

  it("carries the resolved character, not the fallback voice", () => {
    const clips = collectPerLineClips([withTake("c1", 10)], SETTINGS, () => "NICODEMUS")
    expect(clips[0]!.character).toBe("NICODEMUS")
  })
})

describe("naming the files", () => {
  const clip = { lineNumber: 47, character: "MARY MAGDALENE" } as never

  it("puts the line number before the character, so the folder sorts into playing order", () => {
    expect(perLineFileName(clip, "wav", { fileBase: "The Chosen 101", langCode: "swh" }))
      .toBe("The_Chosen_101_swh_L0047_MARY_MAGDALENE.wav")
  })

  it("pads the number so 9 and 100 still sort correctly", () => {
    const early = perLineFileName({ lineNumber: 9, character: "X" } as never, "wav", { langCode: "es" })
    const later = perLineFileName({ lineNumber: 100, character: "X" } as never, "wav", { langCode: "es" })
    expect([later, early].sort()).toEqual([early, later])
  })
})

describe("the manifest", () => {
  it("gives every file a row with both timecode and raw seconds", () => {
    const csv = buildManifestCsv([
      {
        name: "ep_es_L0002_JESUS.wav",
        clip: { cellId: "q2", lineNumber: 2, character: "JESUS", startSec: 61.5, endSec: 63 } as never,
      },
    ])
    const [header, row] = csv.trim().split("\n")
    expect(header).toBe("file,line,character,start,end,start_seconds,end_seconds,cell_id")
    expect(row).toBe("ep_es_L0002_JESUS.wav,2,JESUS,00:01:01.500,00:01:03.000,61.5,63,q2")
  })

  it("quotes a character whose name contains a comma", () => {
    const csv = buildManifestCsv([
      {
        name: "f.wav",
        clip: { cellId: "q1", lineNumber: 1, character: "SIMON, CALLED PETER", startSec: 0, endSec: 1 } as never,
      },
    ])
    expect(csv).toContain('"SIMON, CALLED PETER"')
  })

  it("leaves the timing columns empty for a line that has none", () => {
    const csv = buildManifestCsv([
      { name: "f.wav", clip: { cellId: "q1", lineNumber: 1, character: "X", startSec: null, endSec: null } as never },
    ])
    expect(csv.trim().split("\n")[1]).toBe("f.wav,1,X,,,,,q1")
  })
})

describe("timecode", () => {
  it("formats hours, minutes, seconds and milliseconds", () => {
    expect(timecode(3661.25)).toBe("01:01:01.250")
    expect(timecode(0)).toBe("00:00:00.000")
  })

  it("is blank for no time at all", () => {
    expect(timecode(null)).toBe("")
    expect(timecode(NaN)).toBe("")
  })
})

// ── The timestamp inside the file ────────────────────────────────────────

describe("the BWF timestamp", () => {
  const info = {
    description: "JESUS — line 4",
    originator: "Aquilla",
    originatorRef: "cell-1",
    timeReferenceSamples: 48000 * 12,
  }

  it("is exactly 602 bytes, whatever the text", () => {
    expect(buildBextPayload(info).length).toBe(602)
    expect(buildBextPayload({ ...info, description: "x".repeat(1000) }).length).toBe(602)
  })

  it("writes the sample position where a DAW looks for it", () => {
    const payload = buildBextPayload(info)
    const view = new DataView(payload.buffer)
    // Description(256) + Originator(32) + OriginatorRef(32) + Date(10) + Time(8)
    expect(view.getUint32(338, true)).toBe(48000 * 12)
    expect(view.getUint32(342, true)).toBe(0)
  })

  it("carries a position past the 32-bit boundary into the high word", () => {
    // Over twenty-four hours of samples. Not a real episode, but a wrong split
    // here would silently place a file at the wrong hour.
    const big = 0x1_0000_0002
    const view = new DataView(buildBextPayload({ ...info, timeReferenceSamples: big }).buffer)
    expect(view.getUint32(338, true)).toBe(2)
    expect(view.getUint32(342, true)).toBe(1)
  })

  it("adds the chunk to a WAV without touching its audio", () => {
    const original = makeWav(8)
    const out = withBwfTimestamp(original, info)
    expect(out.length).toBeGreaterThan(original.length)
    // The `data` payload survives byte for byte.
    const text = new TextDecoder("latin1").decode(out)
    const dataAt = text.lastIndexOf("data")
    expect(Array.from(out.subarray(dataAt + 8, dataAt + 16))).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(text).toContain("bext")
  })

  it("keeps the RIFF size honest", () => {
    const out = withBwfTimestamp(makeWav(8), info)
    expect(new DataView(out.buffer).getUint32(4, true)).toBe(out.length - 8)
  })

  it("puts the chunk BEFORE the audio, where a reader expects it", () => {
    const text = new TextDecoder("latin1").decode(withBwfTimestamp(makeWav(), info))
    expect(text.indexOf("bext")).toBeLessThan(text.lastIndexOf("data"))
  })

  it("replaces an existing timestamp rather than writing a second one", () => {
    // Re-exporting must be idempotent; two bext chunks is not a legal file.
    const once = withBwfTimestamp(makeWav(), info)
    const twice = withBwfTimestamp(once, { ...info, timeReferenceSamples: 99 })
    expect(twice.length).toBe(once.length)
    const text = new TextDecoder("latin1").decode(twice)
    expect(text.indexOf("bext")).toBe(text.lastIndexOf("bext"))
    expect(new DataView(twice.buffer).getUint32(text.indexOf("bext") + 8 + 338, true)).toBe(99)
  })

  it("passes a non-WAV through untouched", () => {
    // A webm mic take has nowhere to put this and must not be corrupted trying.
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(withBwfTimestamp(webm, info)).toBe(webm)
  })
})

// ── End to end ───────────────────────────────────────────────────────────

describe("the exported folder", () => {
  const base = {
    settings: SETTINGS,
    projectId: "p1",
    langCode: "es",
    fileBase: "episode",
    fetchBytes: async () => makeWav(),
  }

  it("writes one file per recording, plus a manifest", async () => {
    const result = await exportAudioPerLine({
      ...base,
      cells: [withTake("c1", 10), withTake("c2", 20)],
      resolveName: () => "JESUS",
    })
    const names = Object.keys((await JSZip.loadAsync(result.blob)).files).sort()
    expect(names).toEqual([
      "episode_es_L0001_JESUS.wav",
      "episode_es_L0002_JESUS.wav",
      "manifest.csv",
    ])
    expect(result.files).toBe(2)
  })

  it("stamps each file with its own position", async () => {
    const result = await exportAudioPerLine({
      ...base,
      cells: [withTake("c1", 10), withTake("c2", 20)],
      resolveName: () => "JESUS",
    })
    const zip = await JSZip.loadAsync(result.blob)
    for (const [name, atSec] of [["episode_es_L0001_JESUS.wav", 10], ["episode_es_L0002_JESUS.wav", 20]] as const) {
      const bytes = await zip.file(name)!.async("uint8array")
      const at = new TextDecoder("latin1").decode(bytes).indexOf("bext")
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      expect(view.getUint32(at + 8 + 338, true)).toBe(atSec * 48000)
    }
  })

  it("prefers the lossless sibling of a generated voice", async () => {
    const fetched: string[] = []
    await exportAudioPerLine({
      ...base,
      cells: [
        cell({
          id: "g1",
          startTime: 5,
          endTime: 6,
          selectedGeneratedVoiceAudioId: "gen-1.webm",
          attachments: { "gen-1.webm": { url: "frontier-audio://gen-1.webm", type: "audio" } },
        }),
      ],
      fetchBytes: async ({ audioId, ext }) => { fetched.push(`${audioId}.${ext}`); return makeWav() },
    })
    expect(fetched).toEqual(["gen-1.wav"])
  })

  it("counts a recording it cannot read rather than failing the export", async () => {
    let call = 0
    const result = await exportAudioPerLine({
      ...base,
      cells: [withTake("c1", 10), withTake("c2", 20)],
      fetchBytes: async () => {
        call += 1
        if (call === 1) throw new Error("gone")
        return makeWav()
      },
    })
    expect(result.skipped).toBe(1)
    expect(result.files).toBe(1)
  })

  it("reports an unplaceable recording but still exports it", async () => {
    // The opposite of the character export, where it cannot be placed at all:
    // here the file is perfectly useful, it just has no timestamp to carry.
    const result = await exportAudioPerLine({
      ...base,
      cells: [cell({
        id: "loose",
        selectedAudioId: "a-loose",
        attachments: { "a-loose": { url: "frontier-audio://a-loose.wav", type: "audio" } },
      })],
    })
    expect(result.untimed).toBe(1)
    expect(result.files).toBe(1)
  })

  it("never lets one file overwrite another", async () => {
    // A clip shared by two lines resolves to two rows, and both are wanted.
    const shared = { url: "frontier-audio://shared.wav", type: "audio" as const }
    const result = await exportAudioPerLine({
      ...base,
      cells: [
        cell({ id: "c1", startTime: 10, endTime: 11, selectedAudioId: "shared", attachments: { shared } }),
        cell({ id: "c2", startTime: 20, endTime: 21, selectedAudioId: "shared", attachments: { shared } }),
      ],
      resolveName: () => "CROWD",
    })
    expect(result.files).toBe(2)
    const names = Object.keys((await JSZip.loadAsync(result.blob)).files)
    expect(new Set(names).size).toBe(names.length)
  })

  it("produces an empty archive with no manifest when nothing is recorded", async () => {
    const result = await exportAudioPerLine({ ...base, cells: [cell({ id: "c1", startTime: 1 })] })
    expect(result.files).toBe(0)
    expect(Object.keys((await JSZip.loadAsync(result.blob)).files)).toEqual([])
  })

  it("reports progress over the recordings it will write", async () => {
    const seen: string[] = []
    await exportAudioPerLine({
      ...base,
      cells: [withTake("c1", 10), withTake("c2", 20)],
      onProgress: (d, t) => seen.push(`${d}/${t}`),
    })
    expect(seen).toEqual(["1/2", "2/2"])
  })
})

describe("the manifest inside the archive", () => {
  it("lines up with the files that were written", async () => {
    const result = await exportAudioPerLine({
      settings: SETTINGS,
      projectId: "p1",
      langCode: "es",
      fileBase: "episode",
      fetchBytes: async () => makeWav(),
      cells: [withTake("c1", 61.5)],
      resolveName: () => "JESUS",
    })
    const zip = await JSZip.loadAsync(result.blob)
    const csv = await zip.file("manifest.csv")!.async("string")
    expect(csv).toContain("episode_es_L0001_JESUS.wav,1,JESUS,00:01:01.500")
  })
})

/** Guards the fixture itself: a broken WAV here would make every test above
 *  pass for the wrong reason. */
describe("the test fixture", () => {
  it("is a WAV the writer recognises", () => {
    expect(withBwfTimestamp(makeWav(), {
      description: "", originator: "", originatorRef: "", timeReferenceSamples: 0,
    })).not.toBe(makeWav())
  })
})

// ── AQU-646 stage 4: one folder per track ────────────────────────────────────
//
// Sam, 2026-08-26: per line is the multi-track deliverable and the only one.
// One folder per track, names sanitised, everything a single-track export
// already carries carried per folder.

const track = (id: string, name: string, kind: "audio" | "target-audio" = "audio") =>
  ({ id, kind, name, order: 0 }) as unknown as TimelineTrack

/** A cell with a take on an ADDED track — its slot IS the track id, and it
 *  holds recorded and generated takes alike. */
const withTrackTake = (
  id: string,
  startTime: number,
  trackId: string,
  over: { voiceId?: string | null; ext?: string } = {},
) =>
  cell({
    id,
    startTime,
    endTime: startTime + 1,
    selectedBySlot: { [trackId]: `t-${id}-${trackId}` },
    attachments: {
      [`t-${id}-${trackId}`]: {
        url: `frontier-audio://t-${id}-${trackId}.${over.ext ?? "wav"}`,
        type: "audio",
        voiceId: over.voiceId ?? null,
      },
    },
  } as Partial<CellData>)

describe("the classic single-track export is untouched", () => {
  // THE HEADLINE GUARD. Everything below adds a dimension that most projects
  // will never use, and the price of getting it wrong is that every existing
  // client's zip quietly changes shape. So: no tracks argument, and no tracks
  // that contribute, must both produce exactly the flat zip and the exact CSV
  // schema that shipped.
  it("writes flat entries and the original manifest header with no tracks given", async () => {
    const cells = [withTake("a", 1), withTake("b", 5)]
    const result = await exportAudioPerLine({
      cells, settings: SETTINGS, projectId: "p1", langCode: "es",
      fetchBytes: async () => makeWav(),
    })
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    const names = Object.keys(zip.files).sort()
    expect(names.every((n) => !n.includes("/"))).toBe(true)
    const csv = await zip.file("manifest.csv")!.async("string")
    expect(csv.split("\n")[0]).toBe("file,line,character,start,end,start_seconds,end_seconds,cell_id")
  })

  // A file that HAS added tracks but nobody has recorded onto them is still a
  // one-track export. A lone folder — or one folder beside empty siblings — is
  // a worse deliverable than the flat zip it replaced.
  it("stays flat when only one track actually contributed", async () => {
    const cells = [withTake("a", 1)]
    const result = await exportAudioPerLine({
      cells, settings: SETTINGS, projectId: "p1", langCode: "es",
      tracks: [track("target-audio", "Target audio", "target-audio"), track("trk-es", "Spanish")],
      fetchBytes: async () => makeWav(),
    })
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    expect(Object.keys(zip.files).every((n) => !n.includes("/"))).toBe(true)
  })
})

describe("collecting across tracks", () => {
  it("finds the default row's takes and each added track's own slot", () => {
    const merged = cell({
      id: "c1", startTime: 1, endTime: 2,
      selectedAudioId: "a-main",
      selectedBySlot: { "trk-es": "a-es" },
      attachments: {
        "a-main": { url: "frontier-audio://a-main.wav", type: "audio" },
        "a-es": { url: "frontier-audio://a-es.wav", type: "audio" },
      },
    } as Partial<CellData>)
    const clips = collectPerLineClips(
      [merged], SETTINGS, undefined,
      [track("target-audio", "Target audio", "target-audio"), track("trk-es", "Spanish")],
    )
    expect(clips.map((c) => [c.trackId, c.audioId])).toEqual([
      ["target-audio", "a-main"],
      ["trk-es", "a-es"],
    ])
  })

  // L047 has to mean the forty-seventh line of the episode in EVERY folder, or
  // the folders cannot be talked about together — "L047 in Spanish" would name
  // a different line from "L047 in Target audio".
  it("numbers lines per FILE, never per track", () => {
    const clips = collectPerLineClips(
      [withTake("a", 1), withTrackTake("b", 5, "trk-es"), withTake("c", 9)],
      SETTINGS, undefined,
      [track("target-audio", "Target audio", "target-audio"), track("trk-es", "Spanish")],
    )
    const es = clips.find((c) => c.trackId === "trk-es")!
    expect(es.lineNumber).toBe(2)
    expect(clips.filter((c) => c.trackId === "target-audio").map((c) => c.lineNumber)).toEqual([1, 3])
  })

  // The lossless-WAV preference asks "is this a generated voice". On the
  // default row a pointer says so; an added track's ONE slot holds both kinds,
  // so the take itself has to — via `voiceId`, the discriminator stage 3
  // verified against all three synthesis paths.
  it("reads generated-ness off the take on an added track", () => {
    const [recorded] = collectPerLineClips(
      [withTrackTake("a", 1, "trk-es")], SETTINGS, undefined, [track("trk-es", "Spanish")],
    )
    const [voiced] = collectPerLineClips(
      [withTrackTake("b", 1, "trk-es", { voiceId: "v-mary" })], SETTINGS, undefined,
      [track("trk-es", "Spanish")],
    )
    expect(recorded.generated).toBe(false)
    expect(voiced.generated).toBe(true)
  })

  it("ignores folders and text rows — only audio tracks hold takes", () => {
    const clips = collectPerLineClips(
      [withTake("a", 1)], SETTINGS, undefined,
      [
        track("source-subtitles", "Source text", "target-audio"),
        { id: "grp", kind: "folder", name: "Dubs", order: 1 } as unknown as TimelineTrack,
        track("target-audio", "Target audio", "target-audio"),
      ],
    )
    expect(clips).toHaveLength(1)
    expect(clips[0].trackId).toBe("target-audio")
  })
})

describe("folder names", () => {
  // The SAME sanitiser character names use, deliberately — one rule for both,
  // so a folder and a filename cannot disagree about what is safe. It is
  // ASCII-only (`[^\w.-]`), so accents fold to underscores exactly as they
  // already do for a character called "Nicodemús". Matching that is the point;
  // widening it here would make track folders and character files disagree.
  it("sanitises the way character names already are", () => {
    const names = trackFolderNames([
      { id: "a", name: "Español (M)" },
      { id: "b", name: "Target audio" },
    ])
    expect(names.get("a")).toBe("Espa_ol_M")
    expect(names.get("b")).toBe("Target_audio")
  })

  // Track names are free text and REPEAT in practice — the client's own test
  // file carries two called "Audio". Without de-duplication the second would
  // silently overwrite the first's entire folder.
  it("de-duplicates repeated names rather than letting one eat the other", () => {
    const names = trackFolderNames([
      { id: "a", name: "Audio" },
      { id: "b", name: "Audio" },
      { id: "c", name: "Audio" },
    ])
    expect([...names.values()]).toEqual(["Audio", "Audio_2", "Audio_3"])
  })

  it("never produces an empty folder name", () => {
    expect(trackFolderNames([{ id: "a", name: "///" }]).get("a")).toBeTruthy()
  })
})

describe("the multi-track zip", () => {
  const twoTracks = [
    track("target-audio", "Target audio", "target-audio"),
    track("trk-es", "Spanish"),
  ]
  const cells = [
    cell({
      id: "c1", startTime: 1, endTime: 2,
      selectedAudioId: "a-main",
      selectedBySlot: { "trk-es": "a-es" },
      attachments: {
        "a-main": { url: "frontier-audio://a-main.wav", type: "audio" },
        "a-es": { url: "frontier-audio://a-es.wav", type: "audio" },
      },
    } as Partial<CellData>),
    withTake("c2", 5),
  ]

  it("puts each track's files in its own folder", async () => {
    const result = await exportAudioPerLine({
      cells, settings: SETTINGS, projectId: "p1", langCode: "es", tracks: twoTracks,
      fetchBytes: async () => makeWav(),
    })
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    const audio = Object.keys(zip.files).filter((n) => n.endsWith(".wav")).sort()
    expect(audio).toEqual([
      "Spanish/es_L0001_NO_CHARACTER.wav",
      "Target_audio/es_L0001_NO_CHARACTER.wav",
      "Target_audio/es_L0002_NO_CHARACTER.wav",
    ])
    // The same line name in two folders is two FILES, not a collision — the
    // dedupe suffix must not fire across folders.
    expect(audio.some((n) => n.includes("_2."))).toBe(false)
  })

  it("writes ONE manifest at the root, naming each file's track", async () => {
    const result = await exportAudioPerLine({
      cells, settings: SETTINGS, projectId: "p1", langCode: "es", tracks: twoTracks,
      fetchBytes: async () => makeWav(),
    })
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    expect(Object.keys(zip.files).filter((n) => n.endsWith("manifest.csv"))).toEqual(["manifest.csv"])
    const csv = await zip.file("manifest.csv")!.async("string")
    const [header, ...rows] = csv.trim().split("\n")
    expect(header).toBe("file,track,line,character,start,end,start_seconds,end_seconds,cell_id")
    // The REAL name, not the sanitised folder — the sidecar is where a name a
    // filesystem could not hold survives.
    expect(rows.some((r) => r.includes("Target audio"))).toBe(true)
    expect(rows).toHaveLength(3)
  })
})

// ── AQU-646 stage 4: exports place a take where the take IS ──────────────────
//
// Stage 3 moved placement onto the take — `targetOffsetMs`, with the cell's own
// offset as the permanent fallback for takes made before there was anywhere
// else to put one — and both exporters went on stamping `cell.startTime`. So a
// chip somebody dragged came out of the zip at the position it USED to have,
// and the deliverable disagreed with the timeline that produced it. Wrong on
// the default track today, before any of the multi-track work.
describe("where a take is placed in the export", () => {
  /** Read the BWF time reference back out of a written WAV. */
  const placedSeconds = async (blob: Blob, entry: string) => {
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    const bytes = await zip.file(entry)!.async("uint8array")
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    // Walk the RIFF chunks to `bext`; its timeReference is a 64-bit sample
    // count at offset 338 of the payload (low dword then high).
    let at = 12
    while (at + 8 <= bytes.length) {
      const id = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
      const size = view.getUint32(at + 4, true)
      if (id === "bext") {
        const lo = view.getUint32(at + 8 + 338, true)
        const hi = view.getUint32(at + 8 + 342, true)
        return (hi * 2 ** 32 + lo) / 48000
      }
      at += 8 + size + (size % 2)
    }
    return null
  }

  it("stamps the take's own placement, not the line's start", async () => {
    // The line starts at 10s; the take was dragged to 2.5s past that.
    const dragged = cell({
      id: "c1", startTime: 10, endTime: 14,
      selectedAudioId: "a1",
      attachments: {
        a1: {
          url: "frontier-audio://a1.wav", type: "audio",
          durationMs: 1000, targetOffsetMs: 2500,
        },
      },
    } as Partial<CellData>)
    const result = await exportAudioPerLine({
      cells: [dragged], settings: SETTINGS, projectId: "p1", langCode: "es",
      fetchBytes: async () => makeWav(),
    })
    expect(await placedSeconds(result.blob, "es_L0001_NO_CHARACTER.wav")).toBeCloseTo(12.5, 3)
  })

  it("falls back to the line's start for a take nobody has placed", async () => {
    const result = await exportAudioPerLine({
      cells: [withTake("c1", 7)], settings: SETTINGS, projectId: "p1", langCode: "es",
      fetchBytes: async () => makeWav(),
    })
    expect(await placedSeconds(result.blob, "es_L0001_NO_CHARACTER.wav")).toBeCloseTo(7, 3)
  })

  // The MANIFEST keeps describing the LINE. That is what a reviewer uses to
  // find the line in the episode; repurposing those columns to mean the take's
  // position would silently re-document a CSV somebody is already reading.
  it("leaves the manifest's start/end describing the line", async () => {
    const dragged = cell({
      id: "c1", startTime: 10, endTime: 14,
      selectedAudioId: "a1",
      attachments: {
        a1: { url: "frontier-audio://a1.wav", type: "audio", durationMs: 1000, targetOffsetMs: 2500 },
      },
    } as Partial<CellData>)
    const result = await exportAudioPerLine({
      cells: [dragged], settings: SETTINGS, projectId: "p1", langCode: "es",
      fetchBytes: async () => makeWav(),
    })
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer())
    const csv = await zip.file("manifest.csv")!.async("string")
    expect(csv).toContain("00:00:10.000")
  })
})
