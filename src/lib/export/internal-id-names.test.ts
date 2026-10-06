// AQU-1461: no internal id may reach a delivered audio-export filename.
//
// Covers the guard itself and all three segments the ticket named as candidate
// sources, through the real exporters rather than the helper alone — the bug was
// a name travelling from project data into a zip entry, so the regression has to
// be pinned where that journey ends.
import { describe, it, expect } from "vitest"
import JSZip from "jszip"

import { isInternalIdName, stripInternalIds } from "./internal-id-names"
import {
  characterFileKey,
  characterIdentity,
  exportAudioByCharacter,
  UNNAMED_CHARACTER_KEY,
  UNNAMED_CHARACTER_LABEL,
} from "./audio-by-character"
import { exportAudioPerLine, perLineFileName, trackFolderNames } from "./audio-per-line"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"
import type { TimelineTrack } from "@/lib/timeline/tracks"

/** The id Jade's export actually shipped, completed to a full UUID. */
const REPORTED_ID = "a89dec11-d60e-48c1-9f3a-7b2c4d5e6f70"

function cell(over: Partial<CellData>): CellData {
  return {
    id: "c", fileId: "f", original: "", translated: "", context: "", group: "",
    type: "cue", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [], ...over,
  }
}

const audioCell = (id: string, startTime: number) =>
  cell({
    id,
    startTime,
    endTime: startTime + 1,
    selectedAudioId: `${id}-take`,
    attachments: { [`${id}-take`]: { url: `frontier-audio://${id}-take.wav`, type: "audio/wav" } },
  })

describe("stripInternalIds", () => {
  it("leaves a name with no id in it byte-identical", () => {
    // The whole point of the guard being narrow: every export that already
    // produced readable names must be unchanged.
    for (const name of ["episode-101", "JESUS", "Mary Magdalene", "Target audio", "ACT_2", "a89dec11"]) {
      expect(stripInternalIds(name)).toBe(name)
    }
  })

  it("keeps the readable part of a name that merely contains an id", () => {
    expect(stripInternalIds(`episode-101-${REPORTED_ID}`)).toBe("episode-101")
    expect(stripInternalIds(`${REPORTED_ID}-episode-101`)).toBe("episode-101")
    expect(stripInternalIds(`ep ${REPORTED_ID} 101`)).toBe("ep_101")
  })

  it("empties a name that is nothing but an id, in any case", () => {
    expect(stripInternalIds(REPORTED_ID)).toBe("")
    expect(stripInternalIds(REPORTED_ID.toUpperCase())).toBe("")
    expect(isInternalIdName(REPORTED_ID)).toBe(true)
    expect(isInternalIdName("JESUS")).toBe(false)
    // An empty name is not an id — it has its own fallbacks already.
    expect(isInternalIdName("")).toBe(false)
  })

  it("does not depend on call order", () => {
    // A global regex carries `lastIndex` between calls; a hit must not make the
    // next miss answer wrongly.
    expect(isInternalIdName(REPORTED_ID)).toBe(true)
    expect(stripInternalIds("JESUS")).toBe("JESUS")
    expect(isInternalIdName(REPORTED_ID)).toBe(true)
  })
})

describe("the character segment (AQU-1461 candidate 2)", () => {
  const idNamedVoice: ProjectTtsSettings = {
    voices: [{ id: REPORTED_ID, name: REPORTED_ID }],
    castAssignments: { c1: REPORTED_ID },
  }

  it("reads a voice named by its id as an uncast line, not as a character", () => {
    const identity = characterIdentity(cell({ id: "c1" }), idNamedVoice)
    expect(identity.name).toBe(UNNAMED_CHARACTER_LABEL)
    // Still grouped by the voice, so two id-named voices stay two tracks.
    expect(identity.key).toBe(REPORTED_ID)
  })

  it("still names a properly named cast voice after the character", () => {
    const named: ProjectTtsSettings = {
      voices: [{ id: REPORTED_ID, name: "Mary" }],
      castAssignments: { c1: REPORTED_ID },
    }
    expect(characterIdentity(cell({ id: "c1" }), named).name).toBe("Mary")
  })

  it("keys an all-id character name to NO_CHARACTER and strips a partial one", () => {
    expect(characterFileKey(REPORTED_ID)).toBe(UNNAMED_CHARACTER_KEY)
    expect(characterFileKey(`MARY-${REPORTED_ID}`)).toBe("MARY")
    expect(characterFileKey("JESUS")).toBe("JESUS")
  })

  it("ships no UUID in the character export's entry names", async () => {
    const result = await exportAudioByCharacter({
      cells: [audioCell("c1", 1)],
      settings: idNamedVoice,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => new Float32Array([0.1, 0.2, 0.3]),
    })
    const names = Object.keys((await JSZip.loadAsync(result.blob)).files)
    expect(names).toEqual([`swh_${UNNAMED_CHARACTER_KEY}.wav`])
    expect(names.join()).not.toContain("a89dec11")
  })
})

describe("the file-name segment (AQU-1461 candidate 1)", () => {
  const clip = {
    cellId: "c1", audioId: "a1", url: "frontier-audio://a1.wav",
    lineNumber: 7, character: "JESUS", startSec: 1, endSec: 2,
  }

  it("drops a stem that is nothing but an id rather than shipping it", () => {
    expect(perLineFileName(clip, "wav", { fileBase: REPORTED_ID, langCode: "swh" }))
      .toBe("swh_L0007_JESUS.wav")
  })

  it("keeps the readable part of a stem that contains an id", () => {
    expect(perLineFileName(clip, "wav", { fileBase: `episode-101-${REPORTED_ID}`, langCode: "swh" }))
      .toBe("episode-101_swh_L0007_JESUS.wav")
  })

  it("leaves an ordinary stem untouched", () => {
    expect(perLineFileName(clip, "wav", { fileBase: "episode-101", langCode: "swh" }))
      .toBe("episode-101_swh_L0007_JESUS.wav")
  })

  it("ships no UUID in the per-line export's entry names", async () => {
    const result = await exportAudioPerLine({
      cells: [audioCell("c1", 1)],
      settings: undefined,
      projectId: "p1",
      langCode: "swh",
      fileBase: REPORTED_ID,
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
    })
    const names = Object.keys((await JSZip.loadAsync(result.blob)).files)
    expect(names).toContain(`swh_L0001_${UNNAMED_CHARACTER_KEY}.wav`)
    expect(names.join()).not.toContain("a89dec11")
  })

  it("also keeps the id out of the character export's stem", async () => {
    const result = await exportAudioByCharacter({
      cells: [audioCell("c1", 1)],
      settings: { voices: [{ id: "v-mary", name: "Mary" }], castAssignments: { c1: "v-mary" } },
      projectId: "p1",
      langCode: "swh",
      fileBase: `episode-101-${REPORTED_ID}`,
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => new Float32Array([0.1, 0.2, 0.3]),
    })
    expect(Object.keys((await JSZip.loadAsync(result.blob)).files)).toEqual(["episode-101_swh_Mary.wav"])
  })
})

describe("the track-folder segment (AQU-1461 candidate 3)", () => {
  const track = (id: string, name: string): Pick<TimelineTrack, "id" | "name"> => ({ id, name })

  it("never names a folder after an id", () => {
    const folders = trackFolderNames([
      track("t1", REPORTED_ID),
      track("t2", `Spanish-${REPORTED_ID}`),
      track("target-audio", "Target audio"),
    ])
    expect(folders.get("t1")).toBe("track")
    expect(folders.get("t2")).toBe("Spanish")
    expect(folders.get("target-audio")).toBe("Target_audio")
  })

  it("still de-duplicates once ids are stripped", () => {
    // Two tracks whose names differ only by their id collapse to one readable
    // name, and the second must not silently overwrite the first's folder.
    const folders = trackFolderNames([
      track("t1", `Audio-${REPORTED_ID}`),
      track("t2", "Audio-b1c2d3e4-f5a6-47b8-9c0d-1e2f3a4b5c6d"),
      track("t3", REPORTED_ID),
      track("t4", "b1c2d3e4-f5a6-47b8-9c0d-1e2f3a4b5c6d"),
    ])
    expect([...folders.values()]).toEqual(["Audio", "Audio_2", "track", "track_2"])
  })
})
