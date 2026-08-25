// AQU-646 stage 3 — which slot a track's takes live in.
//
// Small, but two of these are load-bearing enough to be worth stating: the
// default track's slots must never move (every existing take in every project
// is in them), and an added track must get ONE slot rather than a pair, which
// is what makes "exactly one sounding take per track per line" fall out of the
// per-(cell, slot) selection the database already enforces.

import { describe, expect, it } from "vitest"
import {
  DEFAULT_TARGET_TRACK_ID,
  GENERATED_VOICE_SLOT,
  RECORDING_SLOT,
  isDefaultTrackSlot,
  slotForTrack,
  slotsForTrack,
  trackIdForSlot,
} from "./track-slots"

describe("the default track never moves", () => {
  // If this ever changes, every take in every project is orphaned: attach
  // assigns `slot` outright and rebuild replays history, so there is no
  // migration that would survive the next replay.
  it("keeps the two legacy slot names, spelled exactly as they always were", () => {
    expect(RECORDING_SLOT).toBe("recording")
    expect(GENERATED_VOICE_SLOT).toBe("generatedVoice")
    expect(slotForTrack(DEFAULT_TARGET_TRACK_ID)).toBe("recording")
  })

  it("resolves recorded before generated, which is the shipped behaviour", () => {
    expect(slotsForTrack(DEFAULT_TARGET_TRACK_ID)).toEqual(["recording", "generatedVoice"])
  })

  it("maps both of its slots back to it", () => {
    expect(trackIdForSlot("recording")).toBe(DEFAULT_TARGET_TRACK_ID)
    expect(trackIdForSlot("generatedVoice")).toBe(DEFAULT_TARGET_TRACK_ID)
  })
})

describe("an added track", () => {
  const TRK = "019fd21a-a5a4-75d1-b8c4-3b60072a4fc2"

  it("uses its own id as its slot", () => {
    expect(slotForTrack(TRK)).toBe(TRK)
    expect(trackIdForSlot(TRK)).toBe(TRK)
  })

  // ONE SLOT, NOT TWO — recorded and generated takes are siblings in it. That
  // is what makes selection (already per-(cell, slot) in SQL) mean "exactly one
  // sounding take per track per line", with no slot-juggling anywhere.
  it("gets ONE slot, so picking a take deselects its sibling for free", () => {
    expect(slotsForTrack(TRK)).toEqual([TRK])
  })

  it("is never mistaken for a default slot", () => {
    expect(isDefaultTrackSlot(TRK)).toBe(false)
    expect(isDefaultTrackSlot("recording")).toBe(true)
    expect(isDefaultTrackSlot("generatedVoice")).toBe(true)
  })

  // Track ids are uuidv7 and the server's id pattern would never mint a
  // camel-case word, so the two namespaces cannot meet.
  it("cannot collide with the well-known names", () => {
    expect(slotForTrack(TRK)).not.toBe(RECORDING_SLOT)
    expect(slotForTrack(TRK)).not.toBe(GENERATED_VOICE_SLOT)
  })
})
