import { describe, expect, it, beforeEach, afterEach } from "vitest"
import {
  isBacktranslationStale,
  overlayBacktranslation,
  readingsDisagree,
  sameTargetText,
  selectBtFewShotExamples,
  recordFromHydrationRow,
  writeLocalBacktranslation,
  readLocalBacktranslation,
  type BacktranslationRecord,
} from "./bt-record"

function record(over: Partial<BacktranslationRecord> = {}): BacktranslationRecord {
  return {
    cellId: "c1",
    btText: "the house of him",
    targetEventId: "evt-1",
    forText: "maison de lui",
    polished: true,
    author: "alice",
    createdAt: 1,
    ...over,
  }
}

describe("sameTargetText", () => {
  it("treats wrapping whitespace as the same translation", () => {
    expect(sameTargetText("  a  b ", "a b")).toBe(true)
    expect(sameTargetText("a b", "a  b")).toBe(true)
    expect(sameTargetText("a b", "a c")).toBe(false)
  })
})

describe("readingsDisagree", () => {
  it("is quiet when the gloss matches the AI reading", () => {
    expect(readingsDisagree("the house of him", "The house of him!")).toBe(false)
  })

  it("surfaces a real wording difference", () => {
    expect(readingsDisagree("the house of him", "his house")).toBe(true)
  })

  it("does not flag an empty gloss", () => {
    expect(readingsDisagree("the house of him", "")).toBe(false)
  })
})

describe("isBacktranslationStale", () => {
  const committed = {
    committedTranslated: "maison de lui",
    committedTargetEventId: "evt-1",
  }

  it("is current when forText still matches the visible translation", () => {
    expect(isBacktranslationStale({
      record: record(),
      ...committed,
      visibleTranslated: "maison de lui",
    })).toBe(false)
  })

  it("is stale while the user has an unsaved draft", () => {
    expect(isBacktranslationStale({
      record: record(),
      ...committed,
      visibleTranslated: "maison de lui grande",
    })).toBe(true)
  })

  it("stays current after a commit of the same words even if the event id moved", () => {
    // Generated against the draft; user then committed those same words.
    expect(isBacktranslationStale({
      record: record({ targetEventId: "evt-old", forText: "maison de lui grande" }),
      committedTranslated: "maison de lui grande",
      committedTargetEventId: "evt-2",
      visibleTranslated: "maison de lui grande",
    })).toBe(false)
  })

  it("uses the event pin when forText was not stored (server hydrate)", () => {
    expect(isBacktranslationStale({
      record: record({ forText: "" }),
      committedTranslated: "maison de lui",
      committedTargetEventId: "evt-1",
      visibleTranslated: "maison de lui",
    })).toBe(false)

    expect(isBacktranslationStale({
      record: record({ forText: "" }),
      committedTranslated: "maison nouvelle",
      committedTargetEventId: "evt-2",
      visibleTranslated: "maison nouvelle",
    })).toBe(true)
  })

  it("is never stale when there is no reading", () => {
    expect(isBacktranslationStale({
      record: undefined,
      ...committed,
      visibleTranslated: "maison de lui",
    })).toBe(false)
  })
})

describe("overlayBacktranslation", () => {
  const cell = { id: "c1", translated: "maison de lui", targetEventId: "evt-1" }

  it("pins forText to the live translation when the event pin still matches", () => {
    const next = overlayBacktranslation(cell, record({ forText: "" }))
    expect(next.backtranslation).toBe("the house of him")
    expect(next.backtranslationForText).toBe("maison de lui")
    expect(next.backtranslationPolished).toBe(true)
    expect(next.backtranslationTargetEventId).toBe("evt-1")
  })

  it("leaves forText empty when the pin no longer matches — that is the stale signal", () => {
    const next = overlayBacktranslation(
      { ...cell, targetEventId: "evt-2", translated: "maison nouvelle" },
      record({ forText: "" }),
    )
    expect(next.backtranslation).toBe("the house of him")
    expect(next.backtranslationForText).toBe("")
  })

  it("prefers the stored forText over a derived pin match", () => {
    const next = overlayBacktranslation(cell, record({ forText: "maison de lui" }))
    expect(next.backtranslationForText).toBe("maison de lui")
  })

  it("falls back to localStorage when the cache has no row", () => {
    writeLocalBacktranslation("proj", record({ btText: "from disk", forText: "maison de lui" }))
    const next = overlayBacktranslation(cell, undefined, "proj")
    expect(next.backtranslation).toBe("from disk")
  })
})

describe("selectBtFewShotExamples", () => {
  const corpus = new Map([
    ["c2", { translated: "chat noir", targetEventId: "e2" }],
    ["c3", { translated: "livre rouge", targetEventId: "e3" }],
    ["c4", { translated: "stale target", targetEventId: "e4-new" }],
  ])

  it("prefers human-corrected readings and skips the current cell", () => {
    const examples = selectBtFewShotExamples({
      currentCellId: "c1",
      corpusByCellId: corpus,
      records: [
        record({ cellId: "c1", btText: "should skip", forText: "x", polished: false }),
        record({ cellId: "c2", btText: "black cat", forText: "chat noir", polished: false, targetEventId: "e2" }),
        record({ cellId: "c3", btText: "red book", forText: "livre rouge", polished: true, targetEventId: "e3" }),
      ],
    })
    expect(examples).toEqual([
      { target: "chat noir", backtranslation: "black cat" },
      { target: "livre rouge", backtranslation: "red book" },
    ])
  })

  it("skips rows whose pin no longer matches the live target head", () => {
    const examples = selectBtFewShotExamples({
      currentCellId: "c1",
      corpusByCellId: corpus,
      records: [
        record({
          cellId: "c4",
          btText: "old reading",
          forText: "old target",
          targetEventId: "e4-old",
          polished: false,
        }),
      ],
    })
    expect(examples).toEqual([])
  })
})

describe("recordFromHydrationRow", () => {
  it("leaves forText empty so overlay can derive it from the live pin", () => {
    const rec = recordFromHydrationRow({
      cellId: "c1",
      targetEventId: "evt-1",
      btText: "hello",
      polished: true,
      author: "alice",
      createdAt: 9,
    })
    expect(rec.forText).toBe("")
    expect(rec.btText).toBe("hello")
  })
})

describe("localStorage round-trip", () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it("round-trips forText and the polished flag", () => {
    writeLocalBacktranslation("p", record({ polished: false, forText: "abc" }))
    const got = readLocalBacktranslation("p", "c1")
    expect(got?.forText).toBe("abc")
    expect(got?.polished).toBe(false)
  })
})
