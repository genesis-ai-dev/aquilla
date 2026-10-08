import { describe, expect, it } from "vitest"
import {
  buildDraftHealthSpans,
  formatDraftHealthExampleTitle,
  isColorableToken,
  resolveDraftHealthExamples,
} from "./draft-health-spans"

const HOLY_SPIRIT = {
  cellId: "ex-1",
  source: "the Holy Spirit",
  target: "Espiritu Santo",
}

describe("buildDraftHealthSpans", () => {
  it("marks the whole draft as guessed when there are no supporting examples", () => {
    expect(buildDraftHealthSpans("Espiritu Santo came", [])).toEqual([
      { start: 0, end: 19, kind: "guessed" },
    ])
  })

  it("attributes a phrase to the example it came from", () => {
    const spans = buildDraftHealthSpans("Espiritu Santo came yesterday", [HOLY_SPIRIT])
    expect(spans).toEqual([
      {
        start: 0,
        end: 14,
        kind: "supported",
        exampleId: "ex-1",
        exampleSource: "the Holy Spirit",
        exampleTarget: "Espiritu Santo",
      },
      { start: 15, end: 29, kind: "guessed" },
    ])
    expect("Espiritu Santo came yesterday".slice(0, 14)).toBe("Espiritu Santo")
  })

  it("merges adjacent guessed tokens into one span", () => {
    const spans = buildDraftHealthSpans("Espiritu Santo came yesterday", [HOLY_SPIRIT])
    const guessed = spans.filter((span) => span.kind === "guessed")
    expect(guessed).toHaveLength(1)
    expect("Espiritu Santo came yesterday".slice(guessed[0].start, guessed[0].end)).toBe(
      "came yesterday",
    )
  })

  it("picks the longest overlapping example", () => {
    const shorter = { cellId: "ex-short", source: "Spirit", target: "Santo" }
    const spans = buildDraftHealthSpans("Espiritu Santo", [shorter, HOLY_SPIRIT])
    expect(spans).toEqual([
      {
        start: 0,
        end: 14,
        kind: "supported",
        exampleId: "ex-1",
        exampleSource: "the Holy Spirit",
        exampleTarget: "Espiritu Santo",
      },
    ])
  })

  it("leaves punctuation and length-1 tokens uncolored", () => {
    const spans = buildDraftHealthSpans("Espiritu Santo, a sign.", [HOLY_SPIRIT])
    expect(spans.map((span) => ({ kind: span.kind, text: "Espiritu Santo, a sign.".slice(span.start, span.end) }))).toEqual([
      { kind: "supported", text: "Espiritu Santo" },
      { kind: "guessed", text: "sign" },
    ])
  })

  it("keeps combining marks inside a supported word", () => {
    const example = { cellId: "ex-he", source: "in the beginning", target: "בְּרֵאשִׁית" }
    const draft = "בְּרֵאשִׁית בָּרָא"
    const spans = buildDraftHealthSpans(draft, [example])
    expect(spans).toHaveLength(2)
    expect(spans[0]).toMatchObject({ kind: "supported", exampleId: "ex-he" })
    expect(draft.slice(spans[0].start, spans[0].end)).toBe("בְּרֵאשִׁית")
    expect(spans[1].kind).toBe("guessed")
    expect(draft.slice(spans[1].start, spans[1].end)).toBe("בָּרָא")
  })
})

describe("resolveDraftHealthExamples", () => {
  it("prefers live scored pairs over persisted ids", () => {
    const resolved = resolveDraftHealthExamples({
      live: [{ cellId: "live", source: "src", target: "tgt" }],
      exampleIds: ["persisted"],
      lookup: () => ({ source: "old", target: "older" }),
    })
    expect(resolved).toEqual([{ cellId: "live", source: "src", target: "tgt" }])
  })

  it("falls back to persisted example text snapshots", () => {
    const resolved = resolveDraftHealthExamples({
      live: [],
      persisted: [{ cellId: "ex-1", source: "the Holy Spirit", target: "Espiritu Santo" }],
      exampleIds: ["missing"],
      lookup: () => undefined,
    })
    expect(resolved).toEqual([{ cellId: "ex-1", source: "the Holy Spirit", target: "Espiritu Santo" }])
  })

  it("falls back to persisted example ids when no snapshot exists", () => {
    const resolved = resolveDraftHealthExamples({
      live: [],
      exampleIds: ["ex-1", "missing"],
      lookup: (id) => (id === "ex-1" ? { source: "s", target: "t" } : undefined),
    })
    expect(resolved).toEqual([{ cellId: "ex-1", source: "s", target: "t" }])
  })

  it("drops examples whose target is empty", () => {
    expect(resolveDraftHealthExamples({
      live: [{ cellId: "empty", source: "s", target: "   " }],
    })).toEqual([])
  })
})

describe("formatDraftHealthExampleTitle", () => {
  it("names the example as source → target", () => {
    expect(formatDraftHealthExampleTitle("Holy Spirit", "Espiritu Santo")).toBe(
      "Holy Spirit → Espiritu Santo",
    )
  })
})

describe("isColorableToken", () => {
  it("rejects single letters even when they carry marks", () => {
    expect(isColorableToken("a")).toBe(false)
    expect(isColorableToken("of")).toBe(true)
  })
})
