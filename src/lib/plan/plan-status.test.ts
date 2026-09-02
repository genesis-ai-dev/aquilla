import { describe, it, expect } from "vitest"
import {
  planUnitStatus,
  planUnitLabel,
  planUnitId,
  planUnitHasContent,
  sortUnitsInGroup,
  groupPlanUnits,
  planSummary,
  planHasAudio,
  PLAN_GROUP_ORDER,
  type PlanUnit,
  planUnitNote,
  filterPlanUnits,
} from "./plan-status"

function unit(over: Partial<PlanUnit> = {}): PlanUnit {
  return {
    fileId: "f1",
    fileName: "Gospels",
    sectionKey: "",
    totalCount: 100,
    filledCount: 0,
    validatedCount: 0,
    audioCount: 0,
    audioValidatedCount: 0,
    lastEditAt: null,
    targetDate: null,
    doneAt: null,
    doneBy: null,
    ...over,
  }
}

// 2026-09-02T09:00Z. Deadlines are UTC-midnight parses, so the AoE boundary
// for a date D is D + 36h.
const NOW = Date.parse("2026-09-02T09:00:00Z")

describe("planUnitStatus", () => {
  it("marks an untouched unit not started", () => {
    expect(planUnitStatus(unit(), NOW)).toBe("not_started")
  })

  it("counts audio as content, not just text", () => {
    expect(planUnitStatus(unit({ audioCount: 3 }), NOW)).toBe("in_progress")
    expect(planUnitStatus(unit({ filledCount: 3 }), NOW)).toBe("in_progress")
  })

  it("lets the Done mark outrank the numbers", () => {
    // The whole point of an explicit mark: Done at 12% validated is a
    // judgment, not a bug, and the bars stay visible beside it.
    const u = unit({ filledCount: 94, validatedCount: 12, doneAt: NOW, doneBy: "randall" })
    expect(planUnitStatus(u, NOW)).toBe("done")
  })

  it("lets Done outrank an overdue target too", () => {
    const u = unit({ targetDate: "2026-01-01", doneAt: NOW, doneBy: "randall" })
    expect(planUnitStatus(u, NOW)).toBe("done")
  })

  it("is not overdue on the target day anywhere on Earth", () => {
    // Due today: still the 2nd in UTC-12, so not late.
    expect(planUnitStatus(unit({ targetDate: "2026-09-02", filledCount: 1 }), NOW)).toBe("soon")
  })

  it("holds off until the AoE grace has fully elapsed", () => {
    const due = Date.parse("2026-09-02T00:00:00Z")
    const AOE = (24 + 12) * 60 * 60 * 1000
    const u = unit({ targetDate: "2026-09-02", filledCount: 1 })
    expect(planUnitStatus(u, due + AOE - 1)).toBe("soon")
    expect(planUnitStatus(u, due + AOE)).toBe("overdue")
  })

  it("marks a past target overdue even with no content", () => {
    expect(planUnitStatus(unit({ targetDate: "2026-08-01" }), NOW)).toBe("overdue")
  })

  it("calls a target inside the seven-day window due soon", () => {
    expect(planUnitStatus(unit({ targetDate: "2026-09-06", filledCount: 1 }), NOW)).toBe("soon")
  })

  it("leaves a distant target as ordinary progress", () => {
    expect(planUnitStatus(unit({ targetDate: "2026-12-01", filledCount: 1 }), NOW)).toBe("in_progress")
  })

  it("does not promote an untouched unit to in progress just because it has a date", () => {
    expect(planUnitStatus(unit({ targetDate: "2026-12-01" }), NOW)).toBe("not_started")
  })

  it("ignores an unparseable target rather than throwing", () => {
    expect(planUnitStatus(unit({ targetDate: "not-a-date", filledCount: 1 }), NOW)).toBe("in_progress")
  })
})

describe("labels and identity", () => {
  it("names a book unit by its book name, not its code", () => {
    expect(planUnitLabel({ fileName: "Whole Bible", sectionKey: "GEN" })).toBe("Genesis")
  })

  it("falls back to the file name for a file-grain unit", () => {
    expect(planUnitLabel({ fileName: "Episode 1", sectionKey: "" })).toBe("Episode 1")
  })

  it("shows an unrecognised key verbatim rather than pretending", () => {
    expect(planUnitLabel({ fileName: "Stories", sectionKey: "OBS" })).toBe("OBS")
  })

  it("keys a unit by file and section together", () => {
    expect(planUnitId({ fileId: "f1", sectionKey: "GEN" })).toBe("f1:GEN")
    expect(planUnitId({ fileId: "f1", sectionKey: "" })).toBe("f1:")
  })

  it("treats any content as started", () => {
    expect(planUnitHasContent({ filledCount: 0, audioCount: 0 })).toBe(false)
    expect(planUnitHasContent({ filledCount: 0, audioCount: 1 })).toBe(true)
  })
})

describe("sortUnitsInGroup", () => {
  it("puts the soonest target first and undated units last", () => {
    const rows = [
      unit({ fileId: "c", fileName: "C", targetDate: null }),
      unit({ fileId: "a", fileName: "A", targetDate: "2026-12-01" }),
      unit({ fileId: "b", fileName: "B", targetDate: "2026-09-10" }),
    ]
    expect(sortUnitsInGroup(rows).map((u) => u.fileName)).toEqual(["B", "A", "C"])
  })

  it("breaks a tie between books by canonical order, not alphabet", () => {
    const rows = [
      unit({ fileId: "f", sectionKey: "EXO", targetDate: "2026-09-10" }),
      unit({ fileId: "f", sectionKey: "GEN", targetDate: "2026-09-10" }),
    ]
    // Alphabetically Exodus precedes Genesis; canonically it does not.
    expect(sortUnitsInGroup(rows).map((u) => u.sectionKey)).toEqual(["GEN", "EXO"])
  })

  it("orders undated units by label", () => {
    const rows = [
      unit({ fileId: "b", fileName: "Beta" }),
      unit({ fileId: "a", fileName: "Alpha" }),
    ]
    expect(sortUnitsInGroup(rows).map((u) => u.fileName)).toEqual(["Alpha", "Beta"])
  })

  it("does not mutate its input", () => {
    const rows = [unit({ fileName: "B", targetDate: "2026-12-01" }), unit({ fileName: "A", targetDate: "2026-09-10" })]
    const before = rows.map((u) => u.fileName)
    sortUnitsInGroup(rows)
    expect(rows.map((u) => u.fileName)).toEqual(before)
  })
})

describe("groupPlanUnits", () => {
  it("orders groups by urgency and drops empty ones", () => {
    const rows = [
      unit({ fileId: "1", fileName: "Done", doneAt: NOW, doneBy: "r" }),
      unit({ fileId: "2", fileName: "Late", targetDate: "2026-08-01" }),
      unit({ fileId: "3", fileName: "Fresh" }),
    ]
    const groups = groupPlanUnits(rows, NOW)
    expect(groups.map((g) => g.status)).toEqual(["overdue", "not_started", "done"])
    expect(groups.map((g) => g.units.length)).toEqual([1, 1, 1])
  })

  it("never emits a group outside the declared order", () => {
    const rows = [unit({ filledCount: 1 }), unit({ fileId: "2", targetDate: "2026-08-01" })]
    for (const g of groupPlanUnits(rows, NOW)) {
      expect(PLAN_GROUP_ORDER).toContain(g.status)
    }
  })

  it("returns nothing for an empty plan", () => {
    expect(groupPlanUnits([], NOW)).toEqual([])
  })
})

describe("planSummary", () => {
  it("counts done, overdue and in-flight without naming the unit", () => {
    const rows = [
      unit({ fileId: "1", doneAt: NOW, doneBy: "r" }),
      unit({ fileId: "2", doneAt: NOW, doneBy: "r" }),
      unit({ fileId: "3", targetDate: "2026-08-01" }),
      unit({ fileId: "4", filledCount: 5 }),
      unit({ fileId: "5", targetDate: "2026-09-06", filledCount: 2 }),
      unit({ fileId: "6" }),
    ]
    expect(planSummary(rows, NOW)).toEqual({ total: 6, done: 2, overdue: 1, inFlight: 2 })
  })

  it("is all zeroes for an empty plan", () => {
    expect(planSummary([], NOW)).toEqual({ total: 0, done: 0, overdue: 0, inFlight: 0 })
  })
})

describe("planHasAudio", () => {
  it("is false for a text-only project so audio bars can hide entirely", () => {
    expect(planHasAudio([unit(), unit({ fileId: "2", filledCount: 9 })])).toBe(false)
  })

  it("is true as soon as one unit has a recording", () => {
    expect(planHasAudio([unit(), unit({ fileId: "2", audioCount: 1 })])).toBe(true)
  })
})

describe("planUnitNote", () => {
  const base = {
    fileId: "f", fileName: "Mark", sectionKey: "",
    totalCount: 10, filledCount: 0, validatedCount: 0,
    audioCount: 0, audioValidatedCount: 0, lastEditAt: null,
    targetDate: null, doneAt: null, doneBy: null,
  }
  // 2026-09-02T09:00Z. A target of 2026-08-10 expired at 2026-08-11T12:00Z.
  const NOW = Date.parse("2026-09-02T09:00:00Z")

  it("says when a finished unit was marked", () => {
    const at = Date.parse("2026-07-28T00:00:00Z")
    expect(planUnitNote({ ...base, doneAt: at, doneBy: "randall" }, NOW))
      .toEqual({ kind: "marked", at })
  })

  it("counts whole days late from the Anywhere-on-Earth expiry", () => {
    expect(planUnitNote({ ...base, targetDate: "2026-08-10" }, NOW))
      .toEqual({ kind: "days_late", days: 23 })
  })

  it("never reads zero days late — the grace period already carries it past a day", () => {
    // One hour after the Anywhere-on-Earth grace ended, which is 37h past the
    // date itself, so the plain calendar count is already 1.
    const justExpired = Date.parse("2026-08-10T00:00:00Z") + 37 * 3_600_000
    expect(planUnitNote({ ...base, targetDate: "2026-08-10" }, justExpired))
      .toEqual({ kind: "days_late", days: 1 })
  })

  it("counts down for a unit that is due soon", () => {
    expect(planUnitNote({ ...base, targetDate: "2026-09-05", filledCount: 4 }, NOW))
      .toEqual({ kind: "days_until", days: 3 })
  })

  it("flags a started unit that nobody has given a date", () => {
    expect(planUnitNote({ ...base, filledCount: 4 }, NOW)).toEqual({ kind: "no_target" })
  })

  it("has nothing to add about an untouched, undated unit", () => {
    expect(planUnitNote(base, NOW)).toBeNull()
  })
})

describe("filterPlanUnits", () => {
  const u = (over: Partial<PlanUnit>): PlanUnit => ({
    fileId: "f", fileName: "Whole Bible.usfm", sectionKey: "",
    totalCount: 10, filledCount: 0, validatedCount: 0,
    audioCount: 0, audioValidatedCount: 0, lastEditAt: null,
    targetDate: null, doneAt: null, doneBy: null, ...over,
  })
  const GEN = u({ sectionKey: "GEN" })
  const EXO = u({ sectionKey: "EXO", targetDate: "2026-08-10" })
  const EP1 = u({ fileId: "e1", fileName: "Episode 1 — The Wedding" })

  it("passes everything through for an empty or whitespace query", () => {
    expect(filterPlanUnits([GEN, EXO], {})).toHaveLength(2)
    expect(filterPlanUnits([GEN, EXO], { query: "   " })).toHaveLength(2)
  })

  it("matches the display label, not the raw section key alone", () => {
    expect(filterPlanUnits([GEN, EXO], { query: "genes" })).toEqual([GEN])
  })

  it("also matches the book code, so a PM need not spell the name out", () => {
    expect(filterPlanUnits([GEN, EXO], { query: "exo" })).toEqual([EXO])
  })

  it("is case-insensitive in both directions", () => {
    expect(filterPlanUnits([GEN], { query: "GENESIS" })).toEqual([GEN])
    expect(filterPlanUnits([EP1], { query: "wedding" })).toEqual([EP1])
  })

  it("never matches on the file name of a book unit", () => {
    // Every one of a whole-Bible import's 66 units shares one file name, so
    // matching it would select all of them and look like the filter broke.
    expect(filterPlanUnits([GEN, EXO], { query: "Whole Bible" })).toEqual([])
  })

  it("still finds a file-grain unit, whose label IS its file name", () => {
    expect(filterPlanUnits([EP1], { query: "episode" })).toEqual([EP1])
  })

  it("narrows to units nobody has given a date", () => {
    expect(filterPlanUnits([GEN, EXO], { needsDateOnly: true })).toEqual([GEN])
  })

  it("treats a finished unit as needing no date, even with none set", () => {
    const done = u({ sectionKey: "LEV", doneAt: 1 })
    expect(filterPlanUnits([GEN, done], { needsDateOnly: true })).toEqual([GEN])
  })

  it("applies both narrowings together", () => {
    // Each narrowing must exclude something the OTHER would have kept, or the
    // result is decided by one of them alone and the combination is untested.
    // "i" matches Genesis and Leviticus but NOT Exodus; needsDate excludes
    // Leviticus (done) and Exodus (dated). Only Genesis survives both, and
    // each narrowing alone lets something through that the other rejects.
    const done = u({ sectionKey: "LEV", doneAt: 1 })
    expect(filterPlanUnits([GEN, EXO, done], { query: "i" })).toEqual([GEN, done])
    expect(filterPlanUnits([GEN, EXO, done], { needsDateOnly: true })).toEqual([GEN])
    expect(filterPlanUnits([GEN, EXO, done], { query: "i", needsDateOnly: true })).toEqual([GEN])
  })

  it("returns a copy, never the caller's array", () => {
    const input = [GEN]
    expect(filterPlanUnits(input, {})).not.toBe(input)
  })
})
