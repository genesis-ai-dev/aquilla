// AQU-490: the client's half of "how validated is this cell's audio?".
//
// It has to agree with the server's SQL exactly — the gutter and the plan
// board draw the same line — so these tests are deliberately the same cases as
// progress-book-audio.test.ts's histogram block, asked from the other side.
import { describe, it, expect } from "vitest"
import {
  cellAudioVotes,
  isCellAudioValidated,
  selectedDubTakes,
  hasValidatedTake,
  takeValidatorCount,
  isDubTake,
  type AudioAttachmentOut,
  type CellAudioEntry,
} from "./cell-audio-read-types"

const take = (over: Partial<AudioAttachmentOut> & { audioId: string }): AudioAttachmentOut => ({
  url: `frontier-audio://${over.audioId}`,
  slot: "recording",
  mimeType: null, voiceId: null, referenceAudioId: null, durationMs: 1000,
  trimStartMs: null, trimEndMs: null,
  ...over,
})

const entry = (takes: AudioAttachmentOut[], selected: Record<string, string>): CellAudioEntry => ({
  attachments: Object.fromEntries(takes.map((t) => [t.audioId, t])),
  selectedBySlot: selected,
  selectedAudioId: selected.recording ?? null,
  selectedGeneratedVoiceAudioId: selected.generatedVoice ?? null,
  audioTimings: {},
})

describe("cellAudioVotes", () => {
  it("is null when nothing is recorded — not zero", () => {
    expect(cellAudioVotes(entry([], {}))).toBeNull()
    expect(isCellAudioValidated(entry([], {}), 1)).toBe(false)
  })

  it("is the selected take's vote count on an ordinary line", () => {
    const t = take({ audioId: "a1", validatorCount: 2 })
    expect(cellAudioVotes(entry([t], { recording: "a1" }))).toBe(2)
  })

  // THE MULTI-TRACK RULE. Both tracks sound together, so the cell is only as
  // validated as its weakest one.
  it("takes the MINIMUM across tracks, never the maximum", () => {
    const a = take({ audioId: "a1", validatorCount: 3 })
    const b = take({ audioId: "a2", slot: "track-2", validatorCount: 1 })
    const e = entry([a, b], { recording: "a1", "track-2": "a2" })
    expect(cellAudioVotes(e)).toBe(1)
    expect(isCellAudioValidated(e, 2)).toBe(false)
    expect(isCellAudioValidated(e, 1)).toBe(true)
  })

  // The source-clip trap, client side. An imported media file has the shared
  // programme audio selected in the recording slot on EVERY cell; counting it
  // would hold each of them hostage to somebody validating untranslated audio.
  it("ignores the imported source clip entirely", () => {
    const src = take({ audioId: "src", role: "source", validatorCount: 0 })
    expect(cellAudioVotes(entry([src], { recording: "src" }))).toBeNull()

    const dub = take({ audioId: "d1", slot: "track-2", validatorCount: 1 })
    const both = entry([src, dub], { recording: "src", "track-2": "d1" })
    expect(selectedDubTakes(both).map((t) => t.audioId)).toEqual(["d1"])
    expect(cellAudioVotes(both)).toBe(1)
  })

  it("ignores an unselected take, however validated it is", () => {
    const old = take({ audioId: "a0", validatorCount: 9 })
    const fresh = take({ audioId: "a1", validatorCount: 0 })
    expect(cellAudioVotes(entry([old, fresh], { recording: "a1" }))).toBe(0)
  })

  // Version skew during a rollout: a worker that predates AQU-490 sends none
  // of these fields. It must read as "nobody has validated anything", which is
  // what every audio number in the product said anyway — never as a crash.
  it("treats a pre-AQU-490 response as unvalidated, not as broken", () => {
    const legacy = take({ audioId: "a1" })
    expect(takeValidatorCount(legacy)).toBe(0)
    expect(isDubTake(legacy)).toBe(true)
    expect(cellAudioVotes(entry([legacy], { recording: "a1" }))).toBe(0)
  })

  it("survives a selection pointing at a take that is not in the list", () => {
    expect(cellAudioVotes(entry([], { recording: "ghost" }))).toBeNull()
  })
})

describe("hasValidatedTake", () => {
  it("finds the viewer among the validators", () => {
    const t = take({ audioId: "a1", validators: ["ana", "bo"] })
    expect(hasValidatedTake(t, "bo")).toBe(true)
    expect(hasValidatedTake(t, "cy")).toBe(false)
  })

  // A signed-out or not-yet-resolved viewer must not match the empty string a
  // legacy row could carry.
  it("never matches a blank username", () => {
    expect(hasValidatedTake(take({ audioId: "a1", validators: [""] }), "")).toBe(false)
  })
})
