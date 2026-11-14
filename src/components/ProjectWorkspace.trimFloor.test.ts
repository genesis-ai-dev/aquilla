/**
 * AQU-2495 (merge review, Nov 13, note 2): a take's sound never starts before
 * 0:00 — and undoing a trim did not check it. The timeline's left handle, the
 * Station, the Recording tab and the extension editor each hold a take's start
 * trim to `minHeadTrimSec`; an Undo put the old window back as it stood.
 *
 * On device A a take's head is trimmed from 0 to 4 s. On device B someone
 * drags it to 0:00 following the source, which puts its clip at -4 s (allowed
 * since AQU-2495: only its trimmed-off head sits before the file). Back on A,
 * Undo sees the trim unchanged and puts it back to 0, and the take sounds from
 * -4 s: playback skips that part and the exports pull it to 0:00.
 *
 * The workspace's one trim write (`applyTakeTrim`, which the Undo and Redo of
 * a trim go through as well as the lane's drag) now holds the start the same
 * way, through `heldTakeTrim`.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { heldTakeTrim } from "./project-workspace-helpers"
import type { CellData } from "@/hooks/useCells"

const TAKE = "audio-c1-1700000000-take.wav"

/** A line 2 s into its file, its 8 s take's clip placed `targetOffsetMs` from the line's start. */
function lineWithTake(targetOffsetMs: number, trimStartMs?: number): CellData {
  return {
    id: "c1", fileId: "f1", original: "", translated: "", medium: "media", startTime: 2, endTime: 10,
    selectedAudioId: TAKE,
    attachments: {
      [TAKE]: { type: "audio", url: "frontier-audio://take", slot: "recording", durationMs: 8000, targetOffsetMs, ...(trimStartMs != null ? { trimStartMs } : {}) },
    },
  } as unknown as CellData
}
const att = (cell: CellData) => cell.attachments![TAKE]

describe("a trim's start is held so the take's sound never starts before 0:00 (AQU-2495, note 2)", () => {
  it("an Undo putting a 4 s head trim back to 0, after the clip was dragged to -4 s: the trim stays at 4 s", () => {
    // Dragged on device B: clip at 2 - 6 = -4 s, its 4 s head trim sounding from 0:00.
    const cell = lineWithTake(-6000, 4000)
    expect(heldTakeTrim(cell, att(cell), { trimStartMs: undefined, trimEndMs: undefined })).toEqual({ trimStartMs: 4000, trimEndMs: undefined })
    expect(heldTakeTrim(cell, att(cell), { trimStartMs: 1000, trimEndMs: 7000 })).toEqual({ trimStartMs: 4000, trimEndMs: 7000 })
  })

  it("a trim that already keeps the sound inside the file is stored as asked", () => {
    const cell = lineWithTake(-6000, 4000)
    expect(heldTakeTrim(cell, att(cell), { trimStartMs: 5000, trimEndMs: 7000 })).toEqual({ trimStartMs: 5000, trimEndMs: 7000 })
  })

  it("a clip inside the file: no floor, an un-trimmed start stays un-trimmed", () => {
    const cell = lineWithTake(0, 4000)
    expect(heldTakeTrim(cell, att(cell), { trimStartMs: undefined, trimEndMs: undefined })).toEqual({ trimStartMs: undefined, trimEndMs: undefined })
  })

  it("the workspace's trim write holds every trim it stores to it", () => {
    const src = readFileSync(join(__dirname, "ProjectWorkspace.tsx"), "utf8")
    const at = src.indexOf("const applyTakeTrim = useCallback(")
    expect(at).toBeGreaterThan(0)
    const body = src.slice(at, src.indexOf("const readTake = useCallback(", at))
    expect(body).toMatch(/heldTakeTrim\(cell, att, /)
    // Nothing in it stores the trims it was handed rather than the held ones.
    expect(body).not.toMatch(/trims\.trimStartMs/)
  })
})
