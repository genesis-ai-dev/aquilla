import { describe, expect, it } from "vitest"
import { BOUNDARY_LEVEL_QUESTION } from "../completion/seams"
import { mediaSeamCandidates, type MediaCue, type MediaSeamCandidate } from "./media-seams"
import {
  ALL_MEDIA_FEATURES,
  DEFAULT_MEDIA_THRESHOLDS,
  MAX_CANDIDATES_PER_REQUEST,
  MEDIA_REPRESENTATIONS,
  MEDIA_SEAM_QUESTIONS,
  buildMediaSeamRequest,
  combineMediaSeam,
  formatClock,
  heuristicMediaLevel,
  mediaQuestionId,
  mediaSeamWindows,
  parseMediaSeamAnswers,
  type MediaCandidateState,
} from "./media-seam-request"

function track(): MediaCue[] {
  return [
    { key: "a", startMs: 0, endMs: 4_000, text: "He went up the mountain.", speaker: "Narrator" },
    { key: "b", startMs: 6_500, endMs: 10_000, text: "The next morning.", speaker: "Reader", shotCut: true, prosodyReset: 0.8 },
    { key: "c", startMs: 10_200, endMs: 14_000, text: "They came down again.", speaker: "Reader" },
  ]
}

function onlyCandidate(cues: readonly MediaCue[] = track()): MediaSeamCandidate {
  const candidates = mediaSeamCandidates(cues)
  return candidates[0]
}

describe("media seam request", () => {
  it("asks the shared boundary_level question plus the media booleans", () => {
    const cues = track()
    const request = buildMediaSeamRequest(cues, [onlyCandidate(cues)])
    expect(Object.keys(request.questions).sort()).toEqual([
      mediaQuestionId(0, BOUNDARY_LEVEL_QUESTION.key),
      mediaQuestionId(0, "new_scene"),
      mediaQuestionId(0, "speaker_turn_is_new_segment"),
      mediaQuestionId(0, "topic_shift"),
    ].sort())
    const level = request.questions[mediaQuestionId(0, BOUNDARY_LEVEL_QUESTION.key)]
    expect(level.type).toBe("score")
    expect(level.instructions).toMatchObject({ question: BOUNDARY_LEVEL_QUESTION.question })
  })

  it("puts the transcript either side of the boundary into the state", () => {
    const cues = track()
    const state = buildMediaSeamRequest(cues, [onlyCandidate(cues)]).state.candidates[0]
    expect(state.before).toBe("He went up the mountain.")
    expect(state.after).toBe("The next morning. They came down again.")
    expect(state.at).toBe("00:06")
  })

  it("withholds every non-transcript field in representation (a)", () => {
    const cues = track()
    const state = buildMediaSeamRequest(cues, [onlyCandidate(cues)], {
      features: MEDIA_REPRESENTATIONS.a,
    }).state.candidates[0]
    const fields = Object.keys(state) as (keyof MediaCandidateState)[]
    expect(fields.sort()).toEqual(["after", "at", "before", "index"])
    // …and does not ask the speaker question it has withheld the evidence for.
    const questions = Object.keys(
      buildMediaSeamRequest(cues, [onlyCandidate(cues)], { features: MEDIA_REPRESENTATIONS.a }).questions,
    )
    expect(questions).not.toContain(mediaQuestionId(0, "speaker_turn_is_new_segment"))
  })

  it("adds one signal per representation, cumulatively", () => {
    const cues = track()
    const candidate = onlyCandidate(cues)
    const fieldsFor = (features: readonly ("pause" | "speaker" | "shot" | "prosody")[]) =>
      Object.keys(buildMediaSeamRequest(cues, [candidate], { features }).state.candidates[0])

    expect(fieldsFor(MEDIA_REPRESENTATIONS.b)).toContain("pause_ms")
    expect(fieldsFor(MEDIA_REPRESENTATIONS.b)).not.toContain("speaker_change")
    expect(fieldsFor(MEDIA_REPRESENTATIONS.c)).toContain("speaker_change")
    expect(fieldsFor(MEDIA_REPRESENTATIONS.c)).not.toContain("shot_cut")
    expect(fieldsFor(MEDIA_REPRESENTATIONS.d)).toContain("shot_cut")
    expect(fieldsFor(MEDIA_REPRESENTATIONS.d)).not.toContain("prosody_reset")
    expect(fieldsFor(MEDIA_REPRESENTATIONS.e)).toContain("prosody_reset")
    expect(ALL_MEDIA_FEATURES).toEqual(MEDIA_REPRESENTATIONS.e)
  })

  it("omits an unmeasured prosody reset rather than sending a zero", () => {
    const cues = track()
    cues[1].prosodyReset = undefined
    const state = buildMediaSeamRequest(cues, [onlyCandidate(cues)]).state.candidates[0]
    expect(state).not.toHaveProperty("prosody_reset")
  })

  it("throws past the batch cap instead of truncating the window", () => {
    const cues: MediaCue[] = Array.from({ length: 200 }, (_, index) => ({
      key: `c${index}`,
      startMs: index * 10_000,
      endMs: index * 10_000 + 5_000,
      text: "A line.",
    }))
    const candidates = mediaSeamCandidates(cues)
    expect(candidates.length).toBeGreaterThan(MAX_CANDIDATES_PER_REQUEST)
    expect(() => buildMediaSeamRequest(cues, candidates)).toThrow(RangeError)

    const windows = mediaSeamWindows(candidates)
    expect(windows.every((window) => window.length <= MAX_CANDIDATES_PER_REQUEST)).toBe(true)
    expect(windows.flat()).toEqual(candidates)
  })

  it("formats a boundary past the hour with the hour shown", () => {
    expect(formatClock(0)).toBe("00:00")
    expect(formatClock(65_400)).toBe("01:05")
    expect(formatClock(3_725_000)).toBe("1:02:05")
  })
})

describe("parsing answers", () => {
  const answers = (position: number) => ({
    answers: {
      [mediaQuestionId(position, "topic_shift")]: { type: "noul", noul: 0.9 },
      [mediaQuestionId(position, "new_scene")]: { type: "noul", noul: 0.8 },
      [mediaQuestionId(position, BOUNDARY_LEVEL_QUESTION.key)]: {
        score: 3,
        confidence: 0.7,
        probabilities: { "0": 0, "1": 0.1, "2": 0.1, "3": 0.7, "4": 0.1 },
      },
    },
  })

  it("demuxes by candidate position", () => {
    const parsed = parseMediaSeamAnswers(answers(1), 3)
    expect(parsed[0]).toBeNull()
    expect(parsed[1]).toEqual({
      topic_shift: 0.9,
      new_scene: 0.8,
      boundary_level: { level: 3, confidence: 0.7, distribution: [0, 0.1, 0.1, 0.7, 0.1] },
    })
    expect(parsed[2]).toBeNull()
  })

  it("returns a null per candidate for a malformed body rather than throwing", () => {
    expect(parseMediaSeamAnswers(null, 2)).toEqual([null, null])
    expect(parseMediaSeamAnswers({ answers: "nope" }, 1)).toEqual([null])
    expect(parseMediaSeamAnswers({ answers: { m0_topic_shift: { noul: "high" } } }, 1)).toEqual([null])
  })

  it("names every question it can parse", () => {
    expect(MEDIA_SEAM_QUESTIONS.map((question) => question.key)).toEqual([
      "topic_shift",
      "new_scene",
      "speaker_turn_is_new_segment",
    ])
  })
})

describe("combining one candidate", () => {
  it("falls back to the deterministic level when the model is silent", () => {
    const candidate = onlyCandidate()
    expect(combineMediaSeam(null, candidate)).toEqual({
      level: heuristicMediaLevel(candidate),
      decidedBy: "heuristic",
    })
  })

  it("falls back when the model is under the confidence gate", () => {
    const candidate = onlyCandidate()
    const under = DEFAULT_MEDIA_THRESHOLDS.confidence - 0.01
    expect(combineMediaSeam({ boundary_level: { level: 4, confidence: under } }, candidate))
      .toMatchObject({ decidedBy: "heuristic" })
  })

  it("takes the model's own level when it is confident", () => {
    const candidate = onlyCandidate()
    expect(combineMediaSeam({ boundary_level: { level: 3, confidence: 0.9 } }, candidate)).toEqual({
      level: 3,
      confidence: 0.9,
      decidedBy: "model",
    })
  })

  it("promotes to a section when the topic shifts AND a new scene opens", () => {
    const candidate = onlyCandidate()
    const promoted = combineMediaSeam(
      { boundary_level: { level: 2, confidence: 0.9 }, topic_shift: 0.8, new_scene: 0.7 },
      candidate,
    )
    expect(promoted.level).toBe(4)

    // One of the two is not enough — a new scene inside the same topic is a
    // cut, not a chapter.
    const notPromoted = combineMediaSeam(
      { boundary_level: { level: 2, confidence: 0.9 }, topic_shift: 0.1, new_scene: 0.9 },
      candidate,
    )
    expect(notPromoted.level).toBe(2)
  })

  it("demotes a bare speaker turn the model says belongs to one conversation", () => {
    const cues: MediaCue[] = [
      { key: "a", startMs: 0, endMs: 4_000, text: "and then", speaker: "One" },
      { key: "b", startMs: 4_000, endMs: 8_000, text: "and then", speaker: "Two" },
    ]
    const candidate = mediaSeamCandidates(cues)[0]
    expect(candidate.reasons).toEqual(["speaker"])

    expect(
      combineMediaSeam(
        { boundary_level: { level: 4, confidence: 0.9 }, speaker_turn_is_new_segment: 0.1 },
        candidate,
      ).level,
    ).toBe(2)

    // A new reader taking over IS a segment, so the level stands.
    expect(
      combineMediaSeam(
        { boundary_level: { level: 4, confidence: 0.9 }, speaker_turn_is_new_segment: 0.9 },
        candidate,
      ).level,
    ).toBe(4)
  })

  it("does not demote a speaker change that also carries a pause or a shot cut", () => {
    const candidate = onlyCandidate()
    expect(candidate.reasons.length).toBeGreaterThan(1)
    expect(
      combineMediaSeam(
        { boundary_level: { level: 4, confidence: 0.9 }, speaker_turn_is_new_segment: 0.1 },
        candidate,
      ).level,
    ).toBe(4)
  })

  it("rejects a level outside 0-4 instead of clamping it into range", () => {
    const candidate = onlyCandidate()
    expect(combineMediaSeam({ boundary_level: { level: 7, confidence: 0.9 } }, candidate))
      .toMatchObject({ decidedBy: "heuristic" })
  })
})

describe("the deterministic media level", () => {
  const candidate = (over: Partial<MediaSeamCandidate>): MediaSeamCandidate => ({
    index: 0,
    atMs: 10_000,
    pauseMs: 0,
    speakerChange: false,
    shotCut: false,
    prosodyReset: null,
    sentenceFinal: false,
    reasons: ["pause"],
    ...over,
  })

  it("reads a long pause with a shot cut or a new voice as a section", () => {
    expect(heuristicMediaLevel(candidate({ pauseMs: 2_000, shotCut: true }))).toBe(4)
    expect(heuristicMediaLevel(candidate({ pauseMs: 2_000, speakerChange: true }))).toBe(4)
  })

  it("reads a long pause alone as a passage, and a short one as less", () => {
    expect(heuristicMediaLevel(candidate({ pauseMs: 2_000 }))).toBe(3)
    expect(heuristicMediaLevel(candidate({ pauseMs: 700, sentenceFinal: true }))).toBe(2)
    expect(heuristicMediaLevel(candidate({ pauseMs: 300, sentenceFinal: true }))).toBe(1)
  })
})
