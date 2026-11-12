// AQU-2112: the sidebar's chapter list counts AUDIO. An audio-only file — every
// line recorded, no target text, signed off with audio validation — used to draw
// every square untranslated and every chapter at zero, however many takes were
// validated, because the only flag the builder ever read was the text one.
//
// The rule is AQU-2110's, shared: recordings and no text ⇒ audio figures alone;
// both ⇒ text as before plus audio; no recordings ⇒ byte-identical to before.

import { describe, expect, it } from "vitest"
import {
  createChapterHealthBuilder,
  type AudioCellStage,
  type ChapterHealthSource,
} from "./chapter-health"

interface Summary {
  status: string
  translated: string
}

const EMPTY: Summary = { status: "empty", translated: "" }

/**
 * An audio-only file: two chapters of two lines, chapter 1 fully recorded and
 * audio validated, chapter 2 untouched. No cell carries target text — the
 * repro's "language with no written form".
 */
function audioOnly() {
  const summaries = new Map<string, Summary>([
    ["a1", EMPTY], ["a2", EMPTY], ["b1", EMPTY], ["b2", EMPTY],
  ])
  const audio = new Map<string, AudioCellStage>([
    ["a1", "audioValidated"],
    ["a2", "audioValidated"],
  ])
  const chapters: ChapterHealthSource[] = [
    // `translated` counts a take as work (AQU-646), so the store reports 2/2
    // translated here with no text anywhere — which is exactly why the view
    // cannot be decided from it.
    { key: "1", label: "GEN 1", translated: 2, validated: 0, total: 2, cellIds: ["a1", "a2"] },
    { key: "2", label: "GEN 2", translated: 0, validated: 0, total: 2, cellIds: ["b1", "b2"] },
  ]
  const readers = {
    getSummary: (id: string) => summaries.get(id),
    health: () => undefined,
    hasIssue: () => false,
    audioStage: (id: string) => audio.get(id),
  }
  return { summaries, audio, chapters, readers, builder: createChapterHealthBuilder() }
}

describe("chapter health — audio progress (AQU-2112)", () => {
  it("reads an audio-only file in audio figures, with every validated take drawn audio validated", () => {
    const h = audioOnly()
    const [first, second] = h.builder.build(h.chapters, h.readers)

    expect(first.progressView).toBe("audio")
    expect(first.audioRecorded).toBe(2)
    expect(first.audioValidated).toBe(2)
    // The bug, in one assertion: these used to be the only numbers the
    // chapter had, and they cannot move on a language with no written form.
    expect(first.validated).toBe(0)
    expect(first.cells?.map((cell) => cell.stage)).toEqual(["audioValidated", "audioValidated"])

    expect(second.audioRecorded).toBe(0)
    expect(second.audioValidated).toBe(0)
    expect(second.cells?.map((cell) => cell.stage)).toEqual(["untranslated", "untranslated"])
  })

  it("draws a recorded but unvalidated line as recorded, not as untranslated", () => {
    const h = audioOnly()
    h.audio.set("a2", "recorded")
    const [first] = h.builder.build(h.chapters, h.readers)
    expect(first.audioRecorded).toBe(2)
    expect(first.audioValidated).toBe(1)
    expect(first.cells?.map((cell) => cell.stage)).toEqual(["audioValidated", "recorded"])
  })

  it("un-validating a take re-counts the chapter and recolours only its square", () => {
    const h = audioOnly()
    const first = h.builder.build(h.chapters, h.readers)
    h.audio.set("a1", "recorded")
    const second = h.builder.build(h.chapters, h.readers)

    expect(second).not.toBe(first)
    expect(second[0].audioValidated).toBe(1)
    expect(second[0].cells?.[0].stage).toBe("recorded")
    expect(second[0].cells?.[1]).toBe(first[0].cells?.[1])
    // The chapter with no audio at all is untouched work: same object.
    expect(second[1]).toBe(first[1])
  })

  it("returns the same array when a refetch changed nothing", () => {
    const h = audioOnly()
    const first = h.builder.build(h.chapters, h.readers)
    expect(h.builder.build(h.chapters.map((chapter) => ({ ...chapter })), h.readers)).toBe(first)
  })

  it("keeps a mixed file's text squares and figures, and adds the audio pair", () => {
    const h = audioOnly()
    h.summaries.set("a1", { status: "validated", translated: "done" })
    h.chapters[0] = { ...h.chapters[0], validated: 1 }
    const [first] = h.builder.build(h.chapters, h.readers)

    expect(first.progressView).toBe("both")
    expect(first.validated).toBe(1)
    // Text stages, exactly as before — the audio figures stand beside them.
    expect(first.cells?.map((cell) => cell.stage)).toEqual(["validated", "untranslated"])
    expect(first.audioValidated).toBe(2)
  })

  it("leaves a text-only project's chapters byte-identical — no audio keys, no view", () => {
    const h = audioOnly()
    h.summaries.set("a1", { status: "unvalidated", translated: "draft" })
    const withoutAudio = { ...h.readers, audioStage: undefined }
    const [first] = h.builder.build(h.chapters, withoutAudio)

    expect(first).not.toHaveProperty("progressView")
    expect(first).not.toHaveProperty("audioRecorded")
    expect(first).not.toHaveProperty("audioValidated")
    expect(first.cells?.map((cell) => cell.stage)).toEqual(["automatic", "untranslated"])
  })

  it("counts no audio toward a chapter for a heading or parked line", () => {
    const h = audioOnly()
    const readers = { ...h.readers, isExcluded: (id: string) => id === "a2" }
    const [first] = h.builder.build(h.chapters, readers)

    expect(first.audioRecorded).toBe(1)
    expect(first.audioValidated).toBe(1)
    // Still drawn, still "not counted" — AQU-1083/1424's rule is unchanged.
    expect(first.cells?.map((cell) => cell.stage)).toEqual(["audioValidated", "excluded"])
  })

  it("drops the health score from an audio square — health scores text", () => {
    const h = audioOnly()
    const readers = { ...h.readers, health: () => 55 }
    const [first] = h.builder.build(h.chapters, readers)
    expect(first.cells?.map((cell) => cell.health)).toEqual([undefined, undefined])
  })
})
