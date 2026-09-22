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

  it("cannot collide with the well-known names", () => {
    expect(slotForTrack(TRK)).not.toBe(RECORDING_SLOT)
    expect(slotForTrack(TRK)).not.toBe(GENERATED_VOICE_SLOT)
  })
})

// ── A track id that spells a legacy slot name (2026-08-27) ─────────────────
//
// The case above only ever fed a uuidv7, and the comment that used to sit on
// it explained why it could never be anything else: ids are uuidv7, and the
// server's pattern "would not accept a camel-case word". Both halves reason
// about ids THIS client mints, and the second is false — `TRACK_ID_PATTERN` is
// `/^[A-Za-z0-9_-]{1,64}$/`, which accepts both names. So the test could not
// fail no matter what the code did, and the collision it claimed to rule out
// was reachable the whole time.
describe("a track whose id spells a legacy slot name", () => {
  const TRK = "019fd21a-a5a4-75d1-b8c4-3b60072a4fc2"

  // The worker now refuses to CREATE these (RESERVED_SLOT_IDS in
  // file-track-set.ts). This half is what protects a file that already carries
  // one, which no server check can reach retroactively.
  for (const bad of [RECORDING_SLOT, GENERATED_VOICE_SLOT]) {
    it(`quarantines "${bad}" instead of letting it address the dub row`, () => {
      const slot = slotForTrack(bad)
      expect(slot).not.toBe(RECORDING_SLOT)
      expect(slot).not.toBe(GENERATED_VOICE_SLOT)
      expect(isDefaultTrackSlot(slot)).toBe(false)
      // …and it is still ITS slot, so its takes group under it rather than
      // leaking back to the dub row — the attribution bug in reverse.
      expect(trackIdForSlot(slot)).toBe(bad)
    })

    it(`asks for one slot for "${bad}", and the quarantined one`, () => {
      expect(slotsForTrack(bad)).toEqual([slotForTrack(bad)])
    })
  }

  // The consequence that matters: the two rows no longer alias, so a
  // selection on one cannot deselect the other.
  it("leaves the default row's own slots untouched", () => {
    expect(slotForTrack(DEFAULT_TARGET_TRACK_ID)).toBe(RECORDING_SLOT)
    expect(slotForTrack(RECORDING_SLOT)).not.toBe(slotForTrack(DEFAULT_TARGET_TRACK_ID))
    expect(slotsForTrack(DEFAULT_TARGET_TRACK_ID)).toEqual([RECORDING_SLOT, GENERATED_VOICE_SLOT])
  })

  // A real track must be completely unaffected — the quarantine is reached
  // only by the pathological pair.
  it("changes nothing for an ordinary track", () => {
    expect(slotForTrack(TRK)).toBe(TRK)
    expect(trackIdForSlot(TRK)).toBe(TRK)
    expect(slotsForTrack(TRK)).toEqual([TRK])
  })
})
