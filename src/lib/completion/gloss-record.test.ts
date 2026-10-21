/**
 * AQU-1408 §1 — which gloss a cell shows, and when a correction stops applying.
 *
 * The rule under test is the one a translator feels: a correction is a reading
 * of particular words. Once those words change it is not a weaker reading of
 * the new ones, it is a reading of something else — so the cell falls back to
 * the freshly computed gloss rather than showing stale text with a warning.
 * (The AI back-translation does warn-and-offer-refresh instead, because
 * regenerating it costs a model call; recomputing a gloss costs nothing.)
 */
import { describe, expect, it } from "vitest"
import { resolveGloss, glossRecordFromHydrationRow, type GlossRecord } from "./gloss-record"

function record(over: Partial<GlossRecord> = {}): GlossRecord {
  return {
    cellId: "c1",
    glossText: "house of-him",
    targetEventId: "evt-1",
    forText: "maison de lui",
    createdAt: 1,
    ...over,
  }
}

describe("resolveGloss", () => {
  it("shows the computed gloss when nobody has corrected the cell", () => {
    expect(resolveGloss({
      record: undefined,
      computed: "house of him",
      visibleTranslated: "maison de lui",
    })).toEqual({ text: "house of him", corrected: false })
  })

  it("prefers a correction that describes the text on screen, and says so", () => {
    expect(resolveGloss({
      record: record(),
      computed: "house of him",
      visibleTranslated: "maison de lui",
    })).toEqual({ text: "house of-him", corrected: true })
  })

  it("ignores whitespace differences between the correction's text and the cell's", () => {
    expect(resolveGloss({
      record: record({ forText: "maison   de\nlui" }),
      computed: "house of him",
      visibleTranslated: "maison de lui",
    })).toEqual({ text: "house of-him", corrected: true })
  })

  it("falls back to the computed gloss once the translation has changed", () => {
    expect(resolveGloss({
      record: record(),
      computed: "the house belonging to him",
      visibleTranslated: "sa maison",
    })).toEqual({ text: "the house belonging to him", corrected: false })
  })

  it("treats an empty correction as a withdrawal, not as a correction to nothing", () => {
    expect(resolveGloss({
      record: record({ glossText: "   " }),
      computed: "house of him",
      visibleTranslated: "maison de lui",
    })).toEqual({ text: "house of him", corrected: false })
  })

  // A row straight off the read route has no `forText` — the server only
  // stores the pin — so the pin is the only evidence available.
  it("uses the pin for a server row whose pin matches the committed head", () => {
    expect(resolveGloss({
      record: record({ forText: "" }),
      computed: "house of him",
      visibleTranslated: "maison de lui",
      committedTargetEventId: "evt-1",
    })).toEqual({ text: "house of-him", corrected: true })
  })

  it("falls back for a server row pinned to a superseded commit", () => {
    expect(resolveGloss({
      record: record({ forText: "" }),
      computed: "house of him",
      visibleTranslated: "maison de lui",
      committedTargetEventId: "evt-2",
    })).toEqual({ text: "house of him", corrected: false })
  })

  // Neither pin nor forText: the honest answer is "we cannot show this as a
  // correction of what is on screen", not an optimistic guess.
  it("falls back when there is no evidence the correction describes this text", () => {
    expect(resolveGloss({
      record: record({ forText: "", targetEventId: "" }),
      computed: "house of him",
      visibleTranslated: "maison de lui",
    })).toEqual({ text: "house of him", corrected: false })
  })
})

describe("glossRecordFromHydrationRow", () => {
  it("carries the pin and leaves forText empty, so staleness is decided by the pin", () => {
    expect(glossRecordFromHydrationRow({
      cellId: "c1",
      targetEventId: "evt-1",
      glossText: "house of-him",
      author: "jo",
      createdAt: 42,
    })).toEqual({
      cellId: "c1",
      glossText: "house of-him",
      targetEventId: "evt-1",
      forText: "",
      author: "jo",
      createdAt: 42,
    })
  })
})

/**
 * AGENTS.md rule 12 — the read route is the producer, the cache hydration and
 * the resolver are its immediate consumers, and this is the composition.
 *
 * The two halves pass their own tests and still disagree if the route's field
 * names drift from the ones `glossRecordFromHydrationRow` reads: a renamed
 * `glossText` makes every hydrated correction silently absent, which looks
 * exactly like "nobody has corrected this cell". So the rows here are the
 * route's own response shape (see
 * `sync-worker/src/events/cell-glosses-read-route.ts` → `GlossRowOut`), run
 * through hydration into the resolver rather than hand-built at the resolver's
 * door.
 */
describe("read-route row → cache record → resolved gloss", () => {
  const routeResponse = {
    glosses: [
      {
        cellId: "c1",
        targetEventId: "evt-live",
        glossText: "house of-him",
        author: "jo",
        createdAt: 500,
      },
      {
        cellId: "c2",
        targetEventId: "evt-superseded",
        glossText: "big dwelling",
        author: "jo",
        createdAt: 600,
      },
      // A withdrawal travels as an empty string, not as an absent row.
      {
        cellId: "c3",
        targetEventId: "evt-live-3",
        glossText: "",
        author: "jo",
        createdAt: 700,
      },
    ],
  }

  const cache = new Map(
    routeResponse.glosses.map((row) => [row.cellId, glossRecordFromHydrationRow(row)] as const),
  )

  it("shows a hydrated correction whose pin is the cell's committed head", () => {
    expect(resolveGloss({
      record: cache.get("c1"),
      computed: "the house of him",
      visibleTranslated: "maison de lui",
      committedTargetEventId: "evt-live",
    })).toEqual({ text: "house of-him", corrected: true })
  })

  it("falls back for a hydrated correction of a commit that has been superseded", () => {
    expect(resolveGloss({
      record: cache.get("c2"),
      computed: "house big",
      visibleTranslated: "maison grande",
      committedTargetEventId: "evt-newer",
    })).toEqual({ text: "house big", corrected: false })
  })

  it("reads a hydrated empty gloss as a withdrawal, restoring the computed one", () => {
    expect(resolveGloss({
      record: cache.get("c3"),
      computed: "a house",
      visibleTranslated: "une maison",
      committedTargetEventId: "evt-live-3",
    })).toEqual({ text: "a house", corrected: false })
  })

  it("shows the computed gloss for a cell the route returned no row for", () => {
    expect(resolveGloss({
      record: cache.get("c4"),
      computed: "a field",
      visibleTranslated: "un champ",
      committedTargetEventId: "evt-live-4",
    })).toEqual({ text: "a field", corrected: false })
  })
})
