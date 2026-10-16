import { describe, expect, it } from "vitest"
import { TIMELINE_MILESTONE_MS } from "./milestones"
import {
  DEFAULT_MEDIA_CHAPTER_OPTIONS,
  TIMELINE_BUCKET_MS,
  chapterBoundaryTimes,
  mediaChapters,
  mediaSeamCandidates,
  mediaSeamContext,
  timeBucketChapters,
  type MediaCue,
} from "./media-seams"
import type { BoundaryLevel, BoundarySource } from "./ai-sections"

/** Cues laid end to end, each `durationMs` long with `gapMs` of silence after. */
function cues(
  count: number,
  { durationMs = 4_000, gapMs = 200 }: { durationMs?: number; gapMs?: number } = {},
  overrides: Record<number, Partial<MediaCue>> = {},
): MediaCue[] {
  const result: MediaCue[] = []
  let at = 0
  for (let index = 0; index < count; index += 1) {
    const override = overrides[index] ?? {}
    const gapBefore = index === 0 ? 0 : (overrides[index]?.startMs === undefined ? gapMs : 0)
    at += gapBefore
    const cue: MediaCue = {
      key: `cue-${index}`,
      startMs: at,
      endMs: at + durationMs,
      text: `Line ${index}.`,
      ...override,
    }
    result.push(cue)
    at = cue.endMs
  }
  return result
}

/** A level for every candidate, overridable by position. */
function levels(
  count: number,
  level: BoundaryLevel,
  at: Record<number, BoundaryLevel> = {},
): BoundarySource {
  return (index) => {
    if (index < 0 || index >= count) return undefined
    return { level: at[index] ?? level }
  }
}

describe("media seam candidates", () => {
  it("has no candidate between two cues that run on without a pause", () => {
    const track = cues(3, { gapMs: 0 }).map((cue) => ({ ...cue, text: "and then" }))
    expect(mediaSeamCandidates(track)).toEqual([])
  })

  it("proposes a candidate at a long pause, with the pause measured", () => {
    const track = cues(3, { gapMs: 0 })
    track[2].startMs += 2_000
    track[2].endMs += 2_000

    const candidates = mediaSeamCandidates(track)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ index: 1, atMs: track[2].startMs, pauseMs: 2_000 })
    expect(candidates[0].reasons).toContain("pause")
  })

  it("proposes a candidate at a speaker change and at a shot cut with no pause at all", () => {
    const track = cues(3, { gapMs: 0 }, {
      0: { speaker: "Speaker 1", text: "and then" },
      1: { speaker: "Speaker 2", text: "and then" },
      2: { speaker: "Speaker 2", text: "and then", shotCut: true },
    })
    const candidates = mediaSeamCandidates(track)
    expect(candidates.map((candidate) => candidate.reasons)).toEqual([["speaker"], ["shot"]])
  })

  it("does not call a missing speaker label a speaker change", () => {
    const track = cues(2, { gapMs: 0 }, { 0: { speaker: "Speaker 1", text: "and then" }, 1: { text: "and then" } })
    expect(mediaSeamCandidates(track)).toEqual([])
  })

  it("treats a short pause after a full stop as a candidate but not after a comma", () => {
    const stop = cues(2, { gapMs: 300 })
    expect(mediaSeamCandidates(stop)[0]?.reasons).toContain("sentence")

    const comma = cues(2, { gapMs: 300 }).map((cue) => ({ ...cue, text: "a clause," }))
    expect(mediaSeamCandidates(comma)).toEqual([])
  })

  it("clamps an overlapping cue pair to a zero pause rather than a negative one", () => {
    const track = cues(2, { gapMs: 0 })
    track[1].startMs = track[0].endMs - 500
    track[1].shotCut = true
    expect(mediaSeamCandidates(track)[0].pauseMs).toBe(0)
  })
})

describe("media seam context", () => {
  it("takes whole cues from about contextMs either side", () => {
    const track = cues(10, { durationMs: 10_000, gapMs: 0 })
    const candidate = mediaSeamCandidates(
      track.map((cue, index) => (index === 5 ? { ...cue, shotCut: true } : cue)),
    )[0]

    const context = mediaSeamContext(track, candidate, 20_000)
    expect(context.beforeText).toBe("Line 3. Line 4.")
    expect(context.afterText).toBe("Line 5. Line 6.")
  })

  it("always gives each side at least one cue, however small the window", () => {
    const track = cues(4, { durationMs: 60_000, gapMs: 0 }, { 2: { shotCut: true } })
    const candidate = mediaSeamCandidates(track)[0]
    const context = mediaSeamContext(track, candidate, 1_000)
    expect(context.beforeText).toBe("Line 1.")
    expect(context.afterText).toBe("Line 2.")
  })
})

describe("media chapters", () => {
  it("keeps today's buckets when too little of the file is scored", () => {
    const track = cues(40, { durationMs: 4_000, gapMs: 2_000 })
    const candidates = mediaSeamCandidates(track)
    expect(candidates.length).toBeGreaterThan(5)
    expect(mediaChapters(track, candidates, () => undefined)).toBeNull()

    const sparse: BoundarySource = (index) => (index === 0 ? { level: 4 } : undefined)
    expect(mediaChapters(track, candidates, sparse)).toBeNull()
  })

  it("opens a chapter at every candidate scored at the section level", () => {
    // 60 cues x (30s + 2s pause) = 32 min, so every cut clears the minimum.
    const track = cues(60, { durationMs: 30_000, gapMs: 2_000 })
    const candidates = mediaSeamCandidates(track)
    const chapters = mediaChapters(
      track,
      candidates,
      levels(candidates.length, 1, { 9: 4, 29: 4 }),
      { ...DEFAULT_MEDIA_CHAPTER_OPTIONS, maxChapterMs: Number.POSITIVE_INFINITY },
    )

    expect(chapters?.map((chapter) => [chapter.startCueIndex, chapter.endCueIndex])).toEqual([
      [0, 9],
      [10, 29],
      [30, 59],
    ])
    expect(chapters?.[1].startMs).toBe(track[10].startMs)
  })

  it("merges away a chapter under the minimum, keeping the stronger cut", () => {
    const track = cues(60, { durationMs: 30_000, gapMs: 2_000 })
    const candidates = mediaSeamCandidates(track)
    // Candidates 9 and 10 are 32s apart — far under the 90s minimum.
    const chapters = mediaChapters(
      track,
      candidates,
      levels(candidates.length, 1, { 9: 4, 10: 4 }),
      { ...DEFAULT_MEDIA_CHAPTER_OPTIONS, maxChapterMs: Number.POSITIVE_INFINITY },
    )
    expect(chapters).toHaveLength(2)
    expect(chapters?.[1].startCueIndex).toBe(10)
  })

  it("splits an over-long chapter into balanced halves, at a candidate", () => {
    const track = cues(60, { durationMs: 30_000, gapMs: 2_000 })
    const candidates = mediaSeamCandidates(track)
    // Nothing reaches the section level, so the whole 32-min file is one
    // chapter until the maximum forces a split.
    const chapters = mediaChapters(track, candidates, levels(candidates.length, 1))
    expect(chapters).not.toBeNull()
    for (const chapter of chapters ?? []) {
      expect(chapter.endMs - chapter.startMs).toBeLessThanOrEqual(
        DEFAULT_MEDIA_CHAPTER_OPTIONS.maxChapterMs,
      )
      expect(chapter.endMs - chapter.startMs).toBeGreaterThanOrEqual(
        DEFAULT_MEDIA_CHAPTER_OPTIONS.minChapterMs,
      )
    }
    // Every cut landed on a candidate, never on an arbitrary clock time.
    const openings = chapterBoundaryTimes(chapters ?? [])
    expect(openings.every((at) => candidates.some((candidate) => candidate.atMs === at))).toBe(true)
    // Bisection, not shaving: a cut lands within one cue of the file's
    // midpoint, which repeated one-cue shaving off the front never produces.
    const midMs = (track[0].startMs + track[track.length - 1].endMs) / 2
    expect(openings.some((at) => Math.abs(at - midMs) <= 32_000)).toBe(true)
  })

  it("prefers the strongest interior candidate over the most central one", () => {
    const track = cues(60, { durationMs: 30_000, gapMs: 2_000 })
    const candidates = mediaSeamCandidates(track)
    // Candidate 19 (10:40) is level 3 against level 1 everywhere else, and
    // leaves both sides over the minimum, so it wins the first split.
    const chapters = mediaChapters(track, candidates, levels(candidates.length, 1, { 19: 3 }))
    expect(chapterBoundaryTimes(chapters ?? [])[0]).toBe(candidates[19].atMs)
  })

  it("leaves an over-long chapter alone when it has no interior candidate to cut at", () => {
    // Two 20-minute cues that run straight on: no pause, no speaker, no shot
    // cut and no full stop, so nothing in the file is a candidate at all.
    const track = cues(3, { durationMs: 20 * 60_000, gapMs: 0 }).map((cue, index) => ({
      ...cue,
      text: "and then",
      shotCut: index === 1,
    }))
    const candidates = mediaSeamCandidates(track)
    expect(candidates.map((candidate) => candidate.index)).toEqual([0])

    const chapters = mediaChapters(track, candidates, levels(candidates.length, 4))
    expect(chapters).toHaveLength(2)
    for (const chapter of chapters ?? []) {
      expect(chapter.endMs - chapter.startMs).toBeGreaterThan(
        DEFAULT_MEDIA_CHAPTER_OPTIONS.maxChapterMs,
      )
    }
  })
})

describe("the 5-minute bucket baseline", () => {
  it("uses the shipped bucket size", () => {
    expect(TIMELINE_BUCKET_MS).toBe(TIMELINE_MILESTONE_MS)
  })

  it("cuts where timelineMilestones changes bucket, by cue start", () => {
    const track = cues(12, { durationMs: 90_000, gapMs: 0 })
    const chapters = timeBucketChapters(track)
    expect(chapterBoundaryTimes(chapters)).toEqual([
      track[4].startMs,
      track[7].startMs,
      track[10].startMs,
    ])
    for (const time of chapterBoundaryTimes(chapters)) {
      expect(Math.floor(time / TIMELINE_MILESTONE_MS)).toBeGreaterThan(0)
    }
  })

  it("is empty for an empty track", () => {
    expect(timeBucketChapters([])).toEqual([])
    expect(chapterBoundaryTimes([])).toEqual([])
  })
})
