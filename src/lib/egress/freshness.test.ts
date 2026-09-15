// The freshness key is what lets an unchanged project skip a full re-export.
// It must move when the project's exportable content moves (commits bump
// lastEditAt; imports/deletes change the id set; renames change the name;
// validate/unvalidate moves approvedCount) and must NOT move when the server
// merely reorders its recency-sorted file list. Audio mutations move NO
// files-projection field at all — that's what computeAudioFreshness is for.

import { describe, expect, it } from "vitest"
import {
  combineFreshness,
  computeAudioFreshness,
  computeProjectFreshness,
  computeSettingsFreshness,
} from "./freshness"
import type { FileSummary } from "@/lib/sync/cells-read-types"
import type { FileAudioAttachmentsResponse } from "@/lib/sync/cell-audio-read-types"

const file = (over: Partial<FileSummary>): FileSummary => ({
  fileId: "f1",
  projectId: "p1",
  name: "GEN.SFM",
  fileType: "usfm",
  sourceLanguage: "en",
  targetLanguage: "fr",
  cellCount: 10,
  approvedCount: 0,
  filledCount: 5,
  wordCount: 100,
  lastEditAt: 1111,
  ...over,
})

describe("computeProjectFreshness", () => {
  it("is order-insensitive — recency resorting is not a content change", async () => {
    const a = file({ fileId: "a", lastEditAt: 1 })
    const b = file({ fileId: "b", lastEditAt: 2 })
    expect(await computeProjectFreshness([a, b])).toBe(await computeProjectFreshness([b, a]))
  })

  it("changes when a file's lastEditAt moves (any cell commit)", async () => {
    const before = await computeProjectFreshness([file({ lastEditAt: 1111 })])
    const after = await computeProjectFreshness([file({ lastEditAt: 2222 })])
    expect(after).not.toBe(before)
  })

  it("changes when cellCount moves and when the file set changes", async () => {
    const base = await computeProjectFreshness([file({})])
    expect(await computeProjectFreshness([file({ cellCount: 11 })])).not.toBe(base)
    expect(await computeProjectFreshness([file({}), file({ fileId: "f2" })])).not.toBe(base)
    expect(await computeProjectFreshness([])).not.toBe(base)
  })

  it("changes on rename and on validate/unvalidate — neither moves lastEditAt", async () => {
    const base = await computeProjectFreshness([file({})])
    // A rename changes the exported entry paths; stale cache = wrong names.
    expect(await computeProjectFreshness([file({ name: "GENESIS.SFM" })])).not.toBe(base)
    // Validation state is exported in structured formats (status columns).
    expect(await computeProjectFreshness([file({ approvedCount: 3 })])).not.toBe(base)
    expect(await computeProjectFreshness([file({ filledCount: 6 })])).not.toBe(base)
    expect(await computeProjectFreshness([file({ wordCount: 101 })])).not.toBe(base)
  })

  it("distinguishes null lastEditAt (fresh file) from an epoch value", async () => {
    expect(await computeProjectFreshness([file({ lastEditAt: null })])).not.toBe(
      await computeProjectFreshness([file({ lastEditAt: 0 })]),
    )
  })
})

describe("computeAudioFreshness", () => {
  const listing = (
    over: Partial<FileAudioAttachmentsResponse["cells"][string]> = {},
  ): FileAudioAttachmentsResponse => ({
    cells: {
      c1: {
        attachments: {
          a1: {
            audioId: "a1",
            url: "frontier-audio://a1.wav",
            slot: "recording",
            mimeType: "audio/wav",
            voiceId: null,
            referenceAudioId: null,
            durationMs: 1000,
            trimStartMs: null,
            trimEndMs: null,
          },
        },
        selectedAudioId: "a1",
        selectedGeneratedVoiceAudioId: null,
        audioTimings: {},
        ...over,
      },
    },
  })

  it("moves on take select, trim, and voice reassign — mutations invisible to the files projection", async () => {
    const base = await computeAudioFreshness(new Map([["f1", listing()]]))
    // Selecting a different take swaps the exported bytes.
    expect(
      await computeAudioFreshness(new Map([["f1", listing({ selectedAudioId: "a2" })]])),
    ).not.toBe(base)
    // A trim changes the sliced window of the same clip.
    const trimmed = listing()
    trimmed.cells.c1.attachments.a1 = { ...trimmed.cells.c1.attachments.a1, trimStartMs: 250 }
    expect(await computeAudioFreshness(new Map([["f1", trimmed]]))).not.toBe(base)
    // A voice reassign renames voice-grouped entries.
    const revoiced = listing()
    revoiced.cells.c1.attachments.a1 = { ...revoiced.cells.c1.attachments.a1, voiceId: "v2" }
    expect(await computeAudioFreshness(new Map([["f1", revoiced]]))).not.toBe(base)
  })

  it("is stable across file/cell iteration order", async () => {
    const a = new Map([
      ["f1", listing()],
      ["f2", listing()],
    ])
    const b = new Map([
      ["f2", listing()],
      ["f1", listing()],
    ])
    expect(await computeAudioFreshness(a)).toBe(await computeAudioFreshness(b))
  })
})

describe("computeSettingsFreshness / combineFreshness", () => {
  it("settings digest is key-order-independent but value-sensitive", async () => {
    const a = await computeSettingsFreshness({ ttsSettings: null, targetLanguage: "fr" })
    const b = await computeSettingsFreshness({ targetLanguage: "fr", ttsSettings: null })
    expect(a).toBe(b)
    expect(await computeSettingsFreshness({ ttsSettings: null, targetLanguage: "de" })).not.toBe(a)
  })

  it("combineFreshness folds every part — dropping the audio part must change the key", async () => {
    expect(await combineFreshness(["files", "settings", "audio"])).not.toBe(
      await combineFreshness(["files", "settings"]),
    )
    expect(await combineFreshness(["files", "settings"])).toBe(
      await combineFreshness(["files", "settings"]),
    )
  })
})
