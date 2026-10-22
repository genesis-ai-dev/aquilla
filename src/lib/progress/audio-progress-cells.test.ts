// AQU-2110 — the two id sets the chapter picker's audio figures are counted
// from, derived from a file's attachment map by the server's rules.
import { describe, expect, it } from "vitest"
import type { AudioAttachmentOut, CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import {
  EMPTY_AUDIO_PROGRESS_CELL_IDS,
  audioProgressCellIds,
  cellHasOwnTake,
  sameAudioProgressCellIds,
} from "./audio-progress-cells"

/** A take in the desktop id format, seeded with `seed` (a cell id, or the file's). */
function take(
  seed: string,
  slot: string,
  opts: { validatorCount?: number; role?: "dub" | "source"; suffix?: string } = {},
): AudioAttachmentOut {
  const audioId = `audio-${seed}-1700000000000-${opts.suffix ?? "abc123"}`
  return {
    audioId,
    url: `frontier-audio://${audioId}.webm`,
    slot,
    mimeType: "audio/webm",
    voiceId: null,
    referenceAudioId: null,
    durationMs: 1000,
    trimStartMs: null,
    trimEndMs: null,
    role: opts.role ?? "dub",
    validatorCount: opts.validatorCount ?? 0,
    validators: [],
    recordedBy: "tester",
  }
}

function entry(takes: AudioAttachmentOut[]): CellAudioEntry {
  const selectedBySlot = Object.fromEntries(takes.map((t) => [t.slot, t.audioId]))
  return {
    attachments: Object.fromEntries(takes.map((t) => [t.audioId, t])),
    selectedBySlot,
    selectedAudioId: selectedBySlot.recording ?? null,
    selectedGeneratedVoiceAudioId: selectedBySlot.generatedVoice ?? null,
    audioTimings: {},
  }
}

describe("audioProgressCellIds (AQU-2110)", () => {
  it("counts a line recorded by a take of its OWN, and validated once that take meets the requirement", () => {
    const map = new Map<string, CellAudioEntry>([
      ["c1", entry([take("c1", "recording", { validatorCount: 1 })])],
      ["c2", entry([take("c2", "recording", { validatorCount: 0 })])],
    ])
    const ids = audioProgressCellIds(map, 1)
    expect([...ids.recorded].sort()).toEqual(["c1", "c2"])
    expect([...ids.audioValidated]).toEqual(["c1"])
  })

  it("holds a line below validated while its votes are short of the requirement", () => {
    const map = new Map<string, CellAudioEntry>([
      ["c1", entry([take("c1", "recording", { validatorCount: 1 })])],
    ])
    expect(audioProgressCellIds(map, 2).audioValidated.size).toBe(0)
    expect(audioProgressCellIds(map, 2).recorded.size).toBe(1)
    // A requirement of 0 still needs one vote — the floor every audio surface
    // shares through `isTakeValidated`.
    expect(audioProgressCellIds(new Map([["c0", entry([take("c0", "recording")])]]), 0).audioValidated.size).toBe(0)
  })

  it("never counts the imported programme audio: a file-seeded source clip on every cell records nothing", () => {
    const source = take("file-1", "recording", { role: "source" })
    const map = new Map<string, CellAudioEntry>([
      ["c1", entry([source])],
      ["c2", entry([source])],
    ])
    expect(cellHasOwnTake("c1", map.get("c1"))).toBe(false)
    expect(audioProgressCellIds(map, 1)).toBe(EMPTY_AUDIO_PROGRESS_CELL_IDS)
  })

  it("a line with chosen takes on two tracks is validated only once BOTH meet the requirement", () => {
    const oneShort = new Map<string, CellAudioEntry>([
      ["c1", entry([
        take("c1", "recording", { validatorCount: 1, suffix: "aaa" }),
        take("c1", "track-2", { validatorCount: 0, suffix: "bbb" }),
      ])],
    ])
    expect(audioProgressCellIds(oneShort, 1).recorded.has("c1")).toBe(true)
    expect(audioProgressCellIds(oneShort, 1).audioValidated.has("c1")).toBe(false)

    const both = new Map<string, CellAudioEntry>([
      ["c1", entry([
        take("c1", "recording", { validatorCount: 1, suffix: "aaa" }),
        take("c1", "track-2", { validatorCount: 1, suffix: "bbb" }),
      ])],
    ])
    expect(audioProgressCellIds(both, 1).audioValidated.has("c1")).toBe(true)
  })

  it("counts a take on an added track alone, not only the default recording slot", () => {
    const map = new Map<string, CellAudioEntry>([
      ["c1", entry([take("c1", "track-2", { validatorCount: 1 })])],
    ])
    const ids = audioProgressCellIds(map, 1)
    expect(ids.recorded.has("c1")).toBe(true)
    expect(ids.audioValidated.has("c1")).toBe(true)
  })

  it("keeps validated a subset of recorded by construction", () => {
    const map = new Map<string, CellAudioEntry>()
    for (let n = 1; n <= 20; n++) {
      map.set(`c${n}`, entry([take(`c${n}`, "recording", { validatorCount: n % 3 })]))
    }
    const ids = audioProgressCellIds(map, 1)
    for (const id of ids.audioValidated) expect(ids.recorded.has(id)).toBe(true)
    expect(ids.audioValidated.size).toBeLessThan(ids.recorded.size)
  })

  it("compares two derivations by membership, so a refetch that changed nothing is a no-op", () => {
    const build = () => audioProgressCellIds(new Map([
      ["c1", entry([take("c1", "recording", { validatorCount: 1 })])],
      ["c2", entry([take("c2", "recording")])],
    ]), 1)
    expect(sameAudioProgressCellIds(build(), build())).toBe(true)
    const unvalidated = audioProgressCellIds(new Map([
      ["c1", entry([take("c1", "recording", { validatorCount: 0 })])],
      ["c2", entry([take("c2", "recording")])],
    ]), 1)
    expect(sameAudioProgressCellIds(build(), unvalidated)).toBe(false)
    expect(sameAudioProgressCellIds(EMPTY_AUDIO_PROGRESS_CELL_IDS, audioProgressCellIds(new Map(), 1))).toBe(true)
  })
})
