import { describe, expect, it } from "vitest"
import type { BoundaryLevel, BoundarySource } from "./ai-sections"
import {
  PASSAGE_MIN_TRANSLATIONS,
  nextPassageSuggestions,
  parseVerseRef,
  suggestPassages,
  type PassagePlanCell,
} from "./passages"
import { parseSectionBoundaries } from "./section-boundaries"

/** Luke 5 as the CC0 dataset has it: 19/20 at the pericope starts. */
const LUKE_5 = parseSectionBoundaries("LUK.5 1:19 12:19 17:19 27:19 29:1 33:18 36:2")

function verses(book: string, chapter: number, count: number): PassagePlanCell[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `${book}-${chapter}-${index + 1}`,
    text: `verse ${index + 1} text`,
    ref: `${book} ${chapter}:${index + 1}`,
  }))
}

function cells(count: number): PassagePlanCell[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `c${index}`,
    text: `line ${index}`,
  }))
}

function levels(
  count: number,
  level: BoundaryLevel,
  at: Record<number, BoundaryLevel> = {},
): BoundarySource {
  return (index) => (
    index < 0 || index >= count - 1 ? undefined : { level: at[index] ?? level }
  )
}

describe("suggested passages", () => {
  it("takes scripture passages from the dataset, with the model silent", () => {
    // The model would put a boundary nowhere; the dataset still divides Luke 5
    // at the verses published Bibles do. Scripture passages do not wait on a
    // classifier run.
    const passages = suggestPassages(verses("LUK", 5, 39), () => undefined, {
      sectionBoundaries: LUKE_5,
    })

    // 5:29 (1/20) and 5:36 (2/20) are below the default threshold — one
    // house's choice, not a pericope the panel agrees on.
    expect(passages.map((passage) => passage.label)).toEqual([
      "LUK 5:1–11",
      "LUK 5:12–16",
      "LUK 5:17–26",
      "LUK 5:27–32",
      "LUK 5:33–39",
    ])
    expect(passages.map((passage) => passage.source)).toEqual(Array(5).fill("section-counts"))
    expect(passages[1]).toMatchObject({
      key: "passage:LUK-5-12",
      startUnitKey: "LUK-5-12",
      endUnitKey: "LUK-5-16",
      unitCount: 5,
      startRef: "LUK 5:12",
      endRef: "LUK 5:16",
      strength: 19 / 20,
    })
  })

  it("admits more or fewer boundaries as the agreement threshold moves", () => {
    const at = (minTranslations: number) => suggestPassages(
      verses("LUK", 5, 39),
      () => undefined,
      { sectionBoundaries: LUKE_5, minTranslations },
    ).map((passage) => passage.startRef)

    // Every start upstream records, including the 1/20 and 2/20 outliers.
    expect(at(1)).toEqual([
      "LUK 5:1", "LUK 5:12", "LUK 5:17", "LUK 5:27", "LUK 5:29", "LUK 5:33", "LUK 5:36",
    ])
    // Near-unanimity only: 5:33 is 18/20 and drops out.
    expect(at(19)).toEqual(["LUK 5:1", "LUK 5:12", "LUK 5:17", "LUK 5:27"])
  })

  it("falls back to the model where the dataset is silent about a book", () => {
    // Tobit is outside the 20-translation panel. Without the model fallback a
    // deuterocanonical file would get no passages at all.
    const passages = suggestPassages(
      verses("TOB", 3, 20),
      levels(20, 1, { 9: 3 }),
      { sectionBoundaries: LUKE_5 },
    )
    expect(passages.map((passage) => [passage.startRef, passage.source])).toEqual([
      ["TOB 3:1", "model"],
      ["TOB 3:11", "model"],
    ])
  })

  it("falls back to the model for a chapter the dataset does not index", () => {
    const passages = suggestPassages(
      verses("LUK", 6, 20),
      levels(20, 1, { 9: 3 }),
      { sectionBoundaries: LUKE_5 },
    )
    expect(passages.map((passage) => passage.source)).toEqual(["model", "model"])
    expect(passages[1].startRef).toBe("LUK 6:11")
  })

  it("routes a verse bridge to the model rather than guessing from the dataset", () => {
    // `5:2-3` opens where the dataset indexes single verses. The opening verse
    // is looked up; a bridge that starts mid-section is not promoted.
    const bridged: PassagePlanCell[] = [
      { key: "a", text: "first", ref: "LUK 5:1" },
      ...Array.from({ length: 10 }, (_, index) => ({
        key: `b${index}`,
        text: `body ${index}`,
        ref: `LUK 5:${index + 2}-${index + 3}`,
      })),
      { key: "c", text: "the call of Levi", ref: "LUK 5:12" },
    ]
    const passages = suggestPassages(bridged, () => undefined, { sectionBoundaries: LUKE_5 })
    expect(passages.map((passage) => passage.startRef)).toEqual(["LUK 5:1", "LUK 5:12"])
  })

  it("uses model levels for a file with no scripture refs at all", () => {
    const passages = suggestPassages(cells(30), levels(30, 1, { 9: 3, 19: 4 }))
    expect(passages.map((passage) => [passage.startUnitKey, passage.unitCount])).toEqual([
      ["c0", 10],
      ["c10", 10],
      ["c20", 10],
    ])
    // Level 4 is above the passage threshold, so it counts as a passage break
    // too — a section boundary is always also a passage boundary.
    expect(passages).toHaveLength(3)
    expect(passages.map((passage) => passage.label)).toEqual(["line 0", "line 10", "line 20"])
  })

  it("suggests nothing when neither source has an opinion", () => {
    // An empty list means "no suggestions". Returning one passage spanning the
    // file would look like an answer.
    expect(suggestPassages(cells(30), () => undefined)).toEqual([])
    expect(suggestPassages(cells(30), levels(30, 1))).toEqual([])
    expect(suggestPassages([], () => undefined)).toEqual([])
  })

  it("scores a dataset boundary above an unqualified model one", () => {
    // What a caller ranking "the next few ranges" sorts on.
    const fromDataset = suggestPassages(verses("LUK", 5, 39), () => undefined, {
      sectionBoundaries: LUKE_5,
    })
    const fromModel = suggestPassages(cells(30), levels(30, 1, { 9: 3 }))
    expect(fromDataset[1].strength).toBeGreaterThan(fromModel[1].strength)
  })

  it("carries the model's confidence through as the passage strength", () => {
    const passages = suggestPassages(cells(30), (index) => (
      index === 9 ? { level: 3, confidence: 0.82 } : { level: 1, confidence: 0.9 }
    ))
    expect(passages[1].strength).toBeCloseTo(0.82)
  })

  it("labels a cross-chapter passage with both chapters", () => {
    const spanning: PassagePlanCell[] = [
      { key: "a", text: "start", ref: "MRK 1:44" },
      { key: "b", text: "middle", ref: "MRK 1:45" },
      { key: "c", text: "next chapter", ref: "MRK 2:1" },
      { key: "d", text: "still", ref: "MRK 2:2" },
    ]
    const passages = suggestPassages(spanning, levels(4, 1, { 1: 3 }))
    expect(passages.map((passage) => passage.label)).toEqual(["MRK 1:44–45", "MRK 2:1–2"])
  })

  it("labels a passage with its opening words when it has no verse range", () => {
    const workbook: PassagePlanCell[] = [
      { key: "a", text: "Exercise 4: read the passage aloud" },
      { key: "b", text: "then answer" },
      { key: "c", text: "Exercise 5: and he said to them" },
      { key: "d", text: "that they should go" },
    ]
    const passages = suggestPassages(workbook, levels(4, 1, { 1: 3 }))
    expect(passages.map((passage) => passage.label)).toEqual([
      "Exercise 4: read the passage aloud",
      "Exercise 5: and he said to them",
    ])
  })

  it("serves the next few ranges from wherever the translator is", () => {
    const passages = suggestPassages(verses("LUK", 5, 39), () => undefined, {
      sectionBoundaries: LUKE_5,
    })
    expect(nextPassageSuggestions(passages, "LUK-5-12", 2).map((value) => value.label))
      .toEqual(["LUK 5:17–26", "LUK 5:27–32"])
    // Asked from a cell inside a passage, not just its first.
    expect(nextPassageSuggestions(passages, "LUK-5-16", 1).map((value) => value.label))
      .toEqual(["LUK 5:17–26"])
    // Nothing left after the last one.
    expect(nextPassageSuggestions(passages, "LUK-5-39", 3)).toEqual([])
    // No position, or a stale one: offer the start rather than nothing.
    expect(nextPassageSuggestions(passages, undefined, 1).map((value) => value.label))
      .toEqual(["LUK 5:1–11"])
    expect(nextPassageSuggestions(passages, "from-another-file", 1).map((value) => value.label))
      .toEqual(["LUK 5:1–11"])
    expect(nextPassageSuggestions(passages, "LUK-5-1", 0)).toEqual([])
  })

  it("gives the file's opening passage full strength", () => {
    // The start of a file is not a judgment either source made, so a caller
    // ranking suggestions must never rank it last.
    const fromDataset = suggestPassages(verses("LUK", 5, 39), () => undefined, {
      sectionBoundaries: LUKE_5,
    })
    expect(fromDataset[0].strength).toBe(1)
    const fromModel = suggestPassages(cells(30), levels(30, 1, { 9: 3 }))
    expect(fromModel[0].strength).toBe(1)
  })

  it("has a dataset threshold that keeps a quarter-panel agreement", () => {
    expect(PASSAGE_MIN_TRANSLATIONS).toBe(5)
  })

  describe("verse references", () => {
    it("parses the reference forms importers produce", () => {
      expect(parseVerseRef("LUK 5:12")).toEqual({ book: "LUK", chapter: 5, verse: 12 })
      expect(parseVerseRef("1CO 13:4-7")).toEqual({ book: "1CO", chapter: 13, verse: 4 })
      expect(parseVerseRef("gen 1:1a")).toEqual({ book: "GEN", chapter: 1, verse: 1 })
      expect(parseVerseRef("  JHN 3:16  ")).toEqual({ book: "JHN", chapter: 3, verse: 16 })
    })

    it("declines a structural ref, so it is never looked up as a verse", () => {
      expect(parseVerseRef("GEN 2:s1:1")).toBeUndefined()
      expect(parseVerseRef("GEN 2")).toBeUndefined()
      expect(parseVerseRef("not a ref")).toBeUndefined()
      expect(parseVerseRef(undefined)).toBeUndefined()
      expect(parseVerseRef(null)).toBeUndefined()
    })
  })
})
