import { describe, expect, it } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { Concept } from "@/lib/terminology/types"
import type { CorrectionRule } from "@/lib/audio/transcript-corrections"
import {
  cleanupTerms,
  isHumanCorrected,
  neighbourTranscripts,
  pickCleanupPairs,
  pickCorrectedOnly,
  transcriptRowOf,
  type TranscriptRow,
} from "./rows"

const timings = (text: string) =>
  text.split(" ").map((word, i) => ({ word, t0: i, t1: i + 1, start: 0, end: 0 }))

/** A target take: audio id seeded with the cell id (see audioIdSeededWith). */
function take(id: string, opts: { heard?: string; transcript?: string; ai?: boolean; validated?: boolean } = {}): CellData {
  const audioId = `${id}-take1`
  return {
    id,
    fileId: "f1",
    selectedAudioId: audioId,
    attachments: {
      [audioId]: {
        url: `frontier-audio://${audioId}`,
        type: "audio",
        isDeleted: false,
        createdAt: 0,
        updatedAt: 0,
        ...(opts.heard ? { asrText: opts.heard } : {}),
        ...(opts.ai ? { transcriptAi: { model: "m", at: 1, changes: 1 } } : {}),
        ...(opts.validated ? { validatorCount: 1 } : {}),
      },
    },
    audioTimings: opts.transcript ? { [audioId]: timings(opts.transcript) } : {},
  } as unknown as CellData
}

/** A line voiced only by TTS (AQU-2146): the recording slot is empty and the
 *  generated voice is selected in its own slot, as withProjections reads it. */
function voice(id: string, opts: { deleted?: boolean } = {}): CellData {
  const audioId = `${id}-voice1`
  return {
    id,
    fileId: "f1",
    selectedGeneratedVoiceAudioId: audioId,
    attachments: {
      [audioId]: {
        url: `frontier-audio://${audioId}`,
        type: "audio",
        slot: "generatedVoice",
        voiceId: "v1",
        isDeleted: Boolean(opts.deleted),
        createdAt: 0,
        updatedAt: 0,
      },
    },
    audioTimings: {},
  } as unknown as CellData
}

const row = (c: CellData): TranscriptRow => transcriptRowOf(c)!

describe("transcriptRowOf", () => {
  it("reads a take's transcript from its timings and keeps what ASR heard apart from it", () => {
    const r = row(take("c1", { heard: "eema akasema", transcript: "Yesu akasema" }))
    expect(r.transcript).toBe("Yesu akasema")
    expect(r.heard).toBe("eema akasema")
    expect(r.isSourceSegment).toBe(false)
  })

  it("skips a cell with no clip — there is nothing to transcribe", () => {
    expect(transcriptRowOf({ id: "c1", fileId: "f1" } as unknown as CellData)).toBeNull()
  })

  it("falls back to the selected generated voice when the recording slot is empty (AQU-2146)", () => {
    const r = row(voice("c1"))
    expect(r.audioId).toBe("c1-voice1")
    expect(r.isSourceSegment).toBe(false)
    expect(r.transcript).toBe("")
    expect(r.heard).toBeNull()
  })

  it("prefers the recorded take over a generated voice, as playback does", () => {
    const recorded = take("c1", { transcript: "Yesu akasema" })
    const both = {
      ...recorded,
      selectedGeneratedVoiceAudioId: "c1-voice1",
      attachments: { ...recorded.attachments, ...voice("c1").attachments },
    } as CellData
    expect(row(both).audioId).toBe("c1-take1")
  })

  it("skips a line whose only generated voice was deleted", () => {
    expect(transcriptRowOf(voice("c1", { deleted: true }))).toBeNull()
  })

  it("keeps a media line on its source segment, whatever voice sits beside it", () => {
    // The imported clip is seeded with the FILE id and holds the recording slot.
    const clip = "audio-f1-1-src"
    const c = {
      ...voice("c1"),
      medium: "media",
      selectedAudioId: clip,
      transcription: "In the beginning",
      attachments: {
        ...voice("c1").attachments,
        [clip]: { url: `frontier-audio://${clip}`, type: "audio", slot: "recording", isDeleted: false, createdAt: 0, updatedAt: 0 },
      },
    } as unknown as CellData
    const r = row(c)
    expect(r.audioId).toBe(clip)
    expect(r.isSourceSegment).toBe(true)
    expect(r.transcript).toBe("In the beginning")
  })
})

describe("isHumanCorrected", () => {
  const learned: CorrectionRule[] = [{ heard: "eema", corrected: "Yesu", count: 2, updatedAt: 0 }]

  it("does not count a transcript that only carries the learned word fixes — no person changed it", () => {
    expect(isHumanCorrected(row(take("c1", { heard: "eema akasema", transcript: "Yesu akasema" })), learned)).toBe(false)
  })

  it("counts a transcript a person changed beyond the learned fixes", () => {
    expect(isHumanCorrected(row(take("c1", { heard: "eema akasema", transcript: "Yesu alisema" })), learned)).toBe(true)
  })

  it("never counts an AI cleanup awaiting review — the model must not learn from itself", () => {
    expect(isHumanCorrected(row(take("c1", { heard: "eema", transcript: "Yesu alisema", ai: true })), [])).toBe(false)
  })
})

describe("pickCleanupPairs", () => {
  it("offers the corrections most like this recording first, one per distinct correction", () => {
    const target = row(take("t", { heard: "eema akaenda mji" }))
    const rows = [
      row(take("a", { heard: "kitu kingine", transcript: "kitu kingine sana" })),
      row(take("b", { heard: "eema akasema", transcript: "Yesu akasema" })),
      row(take("c", { heard: "eema akasema", transcript: "Yesu akasema" })),
      target,
    ]
    const pairs = pickCleanupPairs(rows, target, target.heard!, [])
    expect(pairs).toEqual([
      { heard: "eema akasema", corrected: "Yesu akasema" },
      { heard: "kitu kingine", corrected: "kitu kingine sana" },
    ])
  })

  it("never uses an AI cleanup or an untouched transcript as an example", () => {
    const target = row(take("t", { heard: "x" }))
    const rows = [
      row(take("a", { heard: "eema", transcript: "Yesu", ai: true })),
      row(take("b", { heard: "same words", transcript: "same words" })),
      target,
    ]
    expect(pickCleanupPairs(rows, target, "x", [])).toEqual([])
  })
})

describe("pickCorrectedOnly", () => {
  it("uses validated transcripts that have no saved ASR text as spelling examples", () => {
    const target = row(take("t", { heard: "x" }))
    const rows = [row(take("a", { transcript: "Yesu akasema", validated: true })), row(take("b", { transcript: "not validated" })), target]
    expect(pickCorrectedOnly(rows, target)).toEqual(["Yesu akasema"])
  })
})

describe("cleanupTerms", () => {
  const concepts = [
    { id: "1", sourceTerm: "Jesus", status: "active", createdAt: "", renderings: [
      { rendering: "Yesu", status: "preferred" },
      { rendering: "Isa", status: "forbidden" },
    ] },
    { id: "2", sourceTerm: "Old", status: "deprecated", createdAt: "", renderings: [{ rendering: "Zamani", status: "preferred" }] },
  ] as unknown as Concept[]

  it("gives a take the lane's renderings, never a forbidden one", () => {
    expect(cleanupTerms(concepts, false)).toEqual([{ term: "Yesu" }])
  })

  it("gives source speech the headwords", () => {
    expect(cleanupTerms(concepts, true)).toEqual([{ term: "Jesus" }])
  })
})

describe("neighbourTranscripts", () => {
  it("is empty for a take: a take's context would be the written line, which must not reach the model", () => {
    const target = row(take("t", { transcript: "a" }))
    expect(neighbourTranscripts([row(take("a", { transcript: "b" })), target], target)).toEqual([])
  })
})
