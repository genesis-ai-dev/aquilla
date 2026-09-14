// AQU-646 stage 6A: the writer and the reader of a mute preference must agree.
//
// `toggleAudibility` had no unit test at all before this file, and that is
// exactly where the bug lived: it classified the derived row's `"target"` key
// as the target flag, while the gutter button read the same key back through
// `slotAudible`, which only knows real SLOTS. `"target"` is not one, so the
// read fell through to the `bySlot` map — a map nothing ever writes that key
// into — and answered "audible" forever. The row genuinely muted; the icon
// never moved (Sam, 2026-08-27: "you can't mute and unmute the audio target
// track").
//
// So every case here is the same shape: FLIP IT, THEN READ IT BACK. A test that
// only asserted what was written would have passed against the broken code.

import { beforeEach, describe, expect, it } from "vitest"

import { audibilityKey, loadAudibility, toggleAudibility, trackAudible } from "./audibility"
import { getQueueAudibility, setQueueAudibility } from "./play-queue"
import { GENERATED_VOICE_SLOT, RECORDING_SLOT } from "@/lib/timeline/track-slots"

/** A user-added track's slot is its own uuidv7 id. */
const ADDED = "01a043cd-1517-758d-9647-70d82c4551c9"
const FILE = "audibility-test-file"

/** Every name a gutter row can address its speaker by. */
const EVERY_ROW = ["source", "target", RECORDING_SLOT, GENERATED_VOICE_SLOT, ADDED]

beforeEach(() => {
  localStorage.removeItem(audibilityKey(FILE))
  setQueueAudibility({ source: true, target: true })
})

describe("trackAudible — the reader agrees with the writer", () => {
  it("starts audible for every row, named or added", () => {
    for (const row of EVERY_ROW) {
      expect(trackAudible(getQueueAudibility(), row), row).toBe(true)
    }
  })

  it.each(EVERY_ROW)("a toggle on %s is visible to the reader, and reversible", (row) => {
    toggleAudibility(FILE, row)
    expect(trackAudible(getQueueAudibility(), row), `${row} after one toggle`).toBe(false)

    // THE SECOND CLICK IS THE POINT. With a reader that never saw the first
    // one, this is the press that silently turned the sound back on.
    toggleAudibility(FILE, row)
    expect(trackAudible(getQueueAudibility(), row), `${row} after two toggles`).toBe(true)
  })

  it("gives the derived row's two names and its own key one shared flag", () => {
    // The row calls itself "target" in the gutter and stores its takes under
    // two legacy slots. All three must answer as one track, or muting from the
    // gutter would leave the queue's overlays sounding.
    toggleAudibility(FILE, "target")
    const state = getQueueAudibility()
    expect(trackAudible(state, "target")).toBe(false)
    expect(trackAudible(state, RECORDING_SLOT)).toBe(false)
    expect(trackAudible(state, GENERATED_VOICE_SLOT)).toBe(false)
    // …and it is the real `target` flag that moved, not a stray map entry.
    expect(state.target).toBe(false)
    expect(state.bySlot?.target).toBeUndefined()
  })

  it("keeps the rows independent of one another", () => {
    toggleAudibility(FILE, "target")
    const state = getQueueAudibility()
    expect(trackAudible(state, "source")).toBe(true)
    expect(trackAudible(state, ADDED)).toBe(true)

    toggleAudibility(FILE, ADDED)
    const after = getQueueAudibility()
    expect(trackAudible(after, ADDED)).toBe(false)
    expect(trackAudible(after, "source")).toBe(true)
    // The derived row stays muted — an added track's flag lives elsewhere.
    expect(trackAudible(after, "target")).toBe(false)
  })

  it("round-trips a muted row through the disk copy", () => {
    toggleAudibility(FILE, "target")
    toggleAudibility(FILE, ADDED)
    // What a later mount would seed from.
    const reloaded = loadAudibility(FILE)
    expect(trackAudible(reloaded, "target")).toBe(false)
    expect(trackAudible(reloaded, ADDED)).toBe(false)
    expect(trackAudible(reloaded, "source")).toBe(true)
  })
})
