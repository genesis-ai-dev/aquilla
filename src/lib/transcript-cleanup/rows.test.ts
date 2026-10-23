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
