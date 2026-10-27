import { describe, expect, it } from "vitest"
import { buildAudioId } from "../../../db/shared/audio-id"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import { cellHasOwnTake, liveAudioProgress } from "./live-audio-progress"

/**
 * One cell's audio in the read shape, with a take seeded the way the recorder
 * seeds it — on the CELL for a dub, on the FILE for the one imported source
 * clip that is shared across every line.
 */
function entry(options: {
  seed: string
  votes?: number
  role?: "dub" | "source"
  slot?: string
}): CellAudioEntry {
  const audioId = buildAudioId(options.seed)
  return {
    attachments: {
      [audioId]: {
        audioId,
        slot: options.slot ?? "recording",
        validatorCount: options.votes ?? 0,
        ...(options.role ? { role: options.role } : {}),
      },
    } as CellAudioEntry["attachments"],
    selectedBySlot: { [options.slot ?? "recording"]: audioId },
    selectedAudioId: options.slot === undefined || options.slot === "recording" ? audioId : null,
    selectedGeneratedVoiceAudioId: null,
    audioTimings: {},
  }
}

const VERSES = [{ id: "c1" }, { id: "c2" }, { id: "c3" }, { id: "c4" }]

describe("liveAudioProgress", () => {
  // WHY: this is the bug. An audio-only file read 0% translated / 0% validated
  // because the open file's live count is derived from cells and cells carry
  // no audio. The counter has to produce the audio pair the sidebar row and
  // the footer draw instead.
  it("counts lines with a take of their own, and those whose audio meets the requirement", () => {
    const audio = new Map([
      ["c1", entry({ seed: "c1", votes: 1 })],
      ["c2", entry({ seed: "c2", votes: 1 })],
      ["c3", entry({ seed: "c3", votes: 0 })],
    ])
    expect(liveAudioProgress(VERSES, audio, 1, true)).toEqual({ recorded: 3, audioValidated: 2 })
  })

  // WHY: a project that asks for two listens must not have its footer call a
  // one-vote line validated while the line's own control still calls it
  // outstanding.
  it("measures validated against the project's audio requirement", () => {
    const audio = new Map([
      ["c1", entry({ seed: "c1", votes: 2 })],
      ["c2", entry({ seed: "c2", votes: 1 })],
    ])
    expect(liveAudioProgress(VERSES, audio, 2, true)).toEqual({ recorded: 2, audioValidated: 1 })
  })

  // WHY: the shared imported programme audio is seeded with the FILE's id and
  // attached to every cell. Counting it would report a whole subtitle file as
  // fully recorded the moment one video was linked.
  it("does not count an imported source recording as a take of the line's own", () => {
    const audio = new Map([
      ["c1", entry({ seed: "file-1", role: "source" })],
      ["c2", entry({ seed: "file-1" })],
    ])
    expect(liveAudioProgress(VERSES, audio, 1, true)).toEqual({ recorded: 0, audioValidated: 0 })
    expect(cellHasOwnTake("c1", audio.get("c1"))).toBe(false)
  })

  // WHY: a take on an added target-audio track is as real as one on the
  // default track — the text view used to miss exactly those (AQU-490).
  it("counts a take selected in a non-default slot", () => {
    const audio = new Map([["c1", entry({ seed: "c1", votes: 1, slot: "track-2" })]])
    expect(liveAudioProgress(VERSES, audio, 1, true)).toEqual({ recorded: 1, audioValidated: 1 })
  })

  // WHY: the structural policy has to subtract from BOTH halves here as it
  // does for text (AQU-1278) — a voiced chapter heading is not work the policy
  // says anyone has to do.
  it("drops structural lines from both halves when the policy excludes them", () => {
    const cells = [
      { id: "v1", type: "verse" },
      { id: "h1", type: "heading" },
      { id: "h2", type: "paratext" },
    ]
    const audio = new Map([
      ["v1", entry({ seed: "v1", votes: 1 })],
      ["h1", entry({ seed: "h1", votes: 1 })],
      ["h2", entry({ seed: "h2", votes: 0 })],
    ])
    expect(liveAudioProgress(cells, audio, 1, true)).toEqual({ recorded: 3, audioValidated: 2 })
    expect(liveAudioProgress(cells, audio, 1, false)).toEqual({ recorded: 1, audioValidated: 1 })
  })

  // WHY: "not loaded yet" and "nothing recorded" must stay distinguishable.
  // A fabricated 0 is the very reading ("0% recorded") this issue is about.
  it("returns null while the attachment map has not loaded", () => {
    expect(liveAudioProgress(VERSES, null, 1, true)).toBeNull()
  })

  it("reports zeroes for a loaded map with no takes in it", () => {
    expect(liveAudioProgress(VERSES, new Map(), 1, true)).toEqual({ recorded: 0, audioValidated: 0 })
  })
})
