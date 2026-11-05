/**
 * AQU-1619: the ASR language follows the AUDIO, not the row — and it now has to
 * hold for TWO callers, not one. The Recording tab's Transcribe button owned
 * this rule; putting a failed transcription on the source/target row gave that
 * row a Retry that has to resolve the language identically, or the retry of a
 * refused source segment would be recognised as the target language.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"

const transcribeCell = vi.hoisted(() => vi.fn(async (_args: unknown) => 3))
vi.mock("./transcribe", () => ({ transcribeCell }))
const notifyAudioAttachmentsChanged = vi.hoisted(() => vi.fn())
vi.mock("./audio-attachments-bus", () => ({ notifyAudioAttachmentsChanged }))

const { asrLanguageForTake, transcribeTake } = await import("./transcribe-take")

const lanes = [
  { id: "lane-src", role: "source", language: "Koine Greek", name: null, langCode: null, legacyTag: null },
  { id: "lane-fr", role: "target", language: "French", name: null, langCode: null, legacyTag: "fr" },
] as unknown as ProjectRecord["lanes"]

const project = { id: "proj-1", lanes } as unknown as Pick<ProjectRecord, "id" | "lanes">

/** An imported media segment: the programme clip is seeded with the FILE id. */
const sourceSegment = {
  id: "cell-1", fileId: "file-1", medium: "media",
  selectedAudioId: "audio-file-1-1700000000000-abc123",
  attachments: { "audio-file-1-1700000000000-abc123": { url: "frontier-audio://x.mp3", type: "audio" } },
} as unknown as CellData

/** A dub take on the same line: seeded with the CELL id. */
const dubTake = {
  id: "cell-1", fileId: "file-1", medium: "media",
  selectedAudioId: "audio-cell-1-1700000000000-abc123",
  attachments: { "audio-cell-1-1700000000000-abc123": { url: "frontier-audio://y.webm", type: "audio" } },
} as unknown as CellData

/** The one call's argument object, asserted to exist rather than assumed. */
function firstCallArgs(): unknown {
  expect(transcribeCell).toHaveBeenCalledTimes(1)
  return transcribeCell.mock.calls[0]?.[0]
}

beforeEach(() => {
  transcribeCell.mockClear()
  notifyAudioAttachmentsChanged.mockClear()
})

describe("asrLanguageForTake", () => {
  it("recognises an imported media segment in the SOURCE lane's language", () => {
    expect(asrLanguageForTake(sourceSegment, lanes, "fr")).toBe("Koine Greek")
  })

  it("recognises a take in the language of the lane being worked in", () => {
    expect(asrLanguageForTake(dubTake, lanes, "fr")).toBe("French")
  })

  it("falls back to the source role when the project has no lane rows", () => {
    // A project predating lane rows still has to resolve to something; what it
    // must NOT do is read the target lane for source speech.
    expect(asrLanguageForTake(sourceSegment, undefined, "fr")).not.toBe("French")
  })
})

describe("transcribeTake", () => {
  it("transcribes THIS clip, in the source language, and lands the timings", async () => {
    const onCommitted = vi.fn(async () => undefined)
    await transcribeTake({
      project, owner: sourceSegment, selectedAudioId: sourceSegment.selectedAudioId!,
      slot: "recording", session: null, targetLang: "fr", onCommitted,
    })
    expect(transcribeCell).toHaveBeenCalledTimes(1)
    const args = firstCallArgs() as Record<string, unknown>
    expect((args.cell as CellData).selectedAudioId).toBe(sourceSegment.selectedAudioId)
    expect(args.language).toBe("Koine Greek")
    expect(args.projectId).toBe("proj-1")
    // Set by a Transcribe/Retry press so a prior Cancel asks again.
    expect(args.askAgain).toBe(true)
    // The flush, then the poke that makes the new timings readable.
    expect(onCommitted).toHaveBeenCalledWith("cell-1")
    expect(notifyAudioAttachmentsChanged).toHaveBeenCalledWith("file-1")
  })

  it("omits targetLang for the default lane rather than naming the '' lane", async () => {
    await transcribeTake({
      project, owner: dubTake, selectedAudioId: dubTake.selectedAudioId!, session: null,
    })
    const args = firstCallArgs() as Record<string, unknown>
    expect("targetLang" in args).toBe(false)
  })
})
