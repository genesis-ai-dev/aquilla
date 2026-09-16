import { describe, it, expect } from "vitest"
import {
  planUnitIsNearlyComplete,
  planUnitStatus,
  planUnitLabel,
  planUnitId,
  planUnitHasContent,
  sortUnitsInGroup,
  groupPlanUnits,
  planSummary,
  planHasAudio,
  PLAN_GROUP_ORDER,
  PLAN_STATUS_LABEL_KEY,
  type PlanUnit,
  type PlanUnitStatus,
  planUnitNote,
  filterPlanUnits,
  planNearlyCompleteThreshold,
  planUnitShortfall,
  planShortfallParts,
  sortNearlyComplete,
  audioFileIds,
  AUDIO_JUDGED_ON_RECORDED,
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

/**
 * A unit stated as the five counts the projection produces, in its own order:
 * cells, filled, validated, audio, audio-validated. Every input the AQU-1278
 * rule reads is one of those five, so a test that states all five has stated
 * its whole input and a reader never has to go looking for the sixth.
 */
function counts(
  cells: number,
  filled: number,
  validated: number,
  audio = 0,
  audioValidated = 0,
  over: Partial<PlanUnit> = {},
): PlanUnit {
  return unit({
    totalCount: cells,
    filledCount: filled,
    validatedCount: validated,
    audioCount: audio,
    audioValidatedCount: audioValidated,
    ...over,
  })
}

/**
 * A fully translated text unit that is exactly `short` cells from finished.
 *
 * The threshold is a claim about HOW MUCH IS LEFT, so these tests say how much
 * is left. Spelling the same unit as a validated count instead — 1,441 of
 * 1,533 — would make every reader checking the 92-versus-93 boundary do the
 * subtraction first, and that arithmetic is exactly what a threshold test must
 * not bury.
 */
function shortBy(cells: number, short: number, over: Partial<PlanUnit> = {}): PlanUnit {
  return counts(cells, cells, cells - short, 0, 0, over)
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

describe("nearly complete (AQU-1278)", () => {
  it("scales with the book: 1,533 cells qualifies 92 short and is refused at 93", () => {
    // Six percent, rounded up. 1,533 × 0.06 is 91.98, so the boundary sits at
    // 92 and one more cell puts the book back in In progress.
    expect(planNearlyCompleteThreshold(1533)).toBe(92)
    expect(planUnitStatus(shortBy(1533, 92), NOW)).toBe("nearly_complete")
    expect(planUnitStatus(shortBy(1533, 93), NOW)).toBe("in_progress")
  })

  it("falls back to a seven-cell floor, which is the only thing that admits a short book", () => {
    // Six percent of Philemon's twenty-five cells is one and a half. A
    // percentage alone would mean the shortest books in the Bible could never
    // be nearly anything, so the floor — not the percentage — is what decides
    // this one, and eight short is still too many.
    expect(Math.ceil(25 * 0.06)).toBe(2)
    expect(planNearlyCompleteThreshold(25)).toBe(7)
    expect(planUnitStatus(shortBy(25, 7), NOW)).toBe("nearly_complete")
    expect(planUnitStatus(shortBy(25, 8), NOW)).toBe("in_progress")
  })

  it("keeps a unit with no cells out, however complete zero of zero looks", () => {
    // A unit whose cell count is zero has a zero shortfall, and zero clears
    // every threshold there is. Without the `totalCount > 0` guard it would be
    // promoted ABOVE In progress and its row would read "Nothing left" — about
    // a file with nothing in it.
    const empty = counts(0, 1, 1)
    expect(planUnitShortfall(empty, false).worst).toBe(0)
    expect(planUnitStatus(empty, NOW)).toBe("in_progress")
  })

  it("keeps a unit nobody has started out, even when the whole book fits under the floor", () => {
    // Five cells, none of them written. The shortfall is the ENTIRE book, and
    // five is under the seven-cell floor, so without the content guard an
    // untouched short file would be announced as nearly finished.
    const untouched = counts(5, 0, 0)
    expect(planUnitShortfall(untouched, false).worst).toBe(5)
    expect(planUnitStatus(untouched, NOW)).toBe("not_started")
  })

  it("stays Overdue when it is also past its target — a blown date outranks a small shortfall", () => {
    const onTime = shortBy(1000, 0)
    const late = shortBy(1000, 0, { targetDate: "2026-08-01" })
    expect(planUnitStatus(onTime, NOW)).toBe("nearly_complete")
    expect(planUnitStatus(late, NOW)).toBe("overdue")
    // It stays findable: there is nothing to list on the second line, which is
    // what renders as "Nothing left" beside the Overdue pill.
    expect(planShortfallParts(planUnitShortfall(late, false))).toEqual([])
  })

  it("still reports an overdue unit as nearly complete, so its row can say so", () => {
    // The status and the question are deliberately different. A unit filed
    // under Overdue because its date blew is often the ONE a manager could
    // close today, and its row has to say "3 cells to validate" rather than go
    // quiet — "23 days late, nothing left" and "23 days late, 300 cells to go"
    // are the same row today and two very different phone calls.
    //
    // This predicate is the single place that asks it. The row and the
    // inspector both call it; before it existed they each stripped the date and
    // re-asked the vocabulary themselves, which is how two surfaces come to
    // disagree about one unit.
    const late = shortBy(1000, 3, { targetDate: "2026-08-01" })
    expect(planUnitStatus(late, NOW)).toBe("overdue")
    expect(planUnitIsNearlyComplete(late, NOW)).toBe(true)

    // A unit someone has MARKED DONE is finished, not nearly finished: it keeps
    // its "marked on" note and must never grow a shortfall line.
    const done = shortBy(1000, 3, { doneAt: Date.parse("2026-08-20T00:00:00Z") })
    expect(planUnitIsNearlyComplete(done, NOW)).toBe(false)

    // And it carries the same audio grain as the status, so a text-only book in
    // a dubbed file answers the same here as it does in the group.
    const inDubbedFile = counts(100, 100, 100, 0, 0)
    const audioFiles = new Set([inDubbedFile.fileId])
    expect(planUnitIsNearlyComplete(inDubbedFile, NOW, audioFiles)).toBe(false)
    expect(planUnitIsNearlyComplete(inDubbedFile, NOW, new Set<string>())).toBe(true)
  })

  it("pins AUDIO_JUDGED_ON_RECORDED true — flip it for AQU-490 and THIS test fails first", () => {
    expect(AUDIO_JUDGED_ON_RECORDED).toBe(true)
  })

  it("judges audio on recorded, so a fully recorded book with no reviewed takes qualifies", () => {
    // No client emits `cell.audio.validate`, so audioValidatedCount is zero on
    // every project alive; measuring it would put every audio book permanently
    // out of reach of this group. Each expectation below carries BOTH arms, so
    // when AQU-490 flips the constant these lines state what the validated
    // reading produces instead — a thousand unreviewed takes, far outside a
    // threshold of sixty — and the tripwire above is what tells you to look.
    const recorded = counts(1000, 1000, 1000, 1000, 0)
    const audioFiles = new Set(["f1"])
    const s = planUnitShortfall(recorded, true)
    expect(planNearlyCompleteThreshold(1000)).toBe(60)
    expect(s.toAudioValidate).toBe(AUDIO_JUDGED_ON_RECORDED ? 0 : 1000)
    expect(s.worst).toBe(AUDIO_JUDGED_ON_RECORDED ? 0 : 1000)
    expect(planUnitStatus(recorded, NOW, audioFiles)).toBe(
      AUDIO_JUDGED_ON_RECORDED ? "nearly_complete" : "in_progress",
    )
  })
})

describe("the audio gate is per FILE, not per project", () => {
  // The regression that would make this whole feature do nothing. A project
  // holding one dubbed episode alongside sixty-five text books answers YES to
  // `planHasAudio`. Judged project-wide, every text book's audio shortfall is
  // its entire cell count, audio is always the worse medium, and not one unit
  // on any mixed project would ever be nearly complete.
  const episode = counts(500, 500, 500, 500, 0, { fileId: "ep1", fileName: "Episode 1" })
  const books = Array.from({ length: 65 }, (_, i) =>
    shortBy(1000, 3, { fileId: "bible", fileName: "Whole Bible.usfm", sectionKey: `B${i}` }),
  )
  const rows = [episode, ...books]

  it("names only the files that carry recordings", () => {
    expect([...audioFileIds(rows)]).toEqual(["ep1"])
    // And the project-wide question answers yes, which is precisely the trap:
    // `planHasAudio` is the right function for "show the audio bars" and the
    // wrong one for "is audio expected of THIS unit".
    expect(planHasAudio(rows)).toBe(true)
  })

  it("judges the text books on text alone, so all sixty-five can be nearly complete", () => {
    const audioFiles = audioFileIds(rows)
    for (const b of books) expect(planUnitStatus(b, NOW, audioFiles)).toBe("nearly_complete")
    expect(planSummary(rows, NOW).nearlyComplete).toBe(66)
  })

  it("would sink every one of them if audio were read project-wide", () => {
    const projectWide = new Set(["ep1", "bible"])
    for (const b of books) expect(planUnitStatus(b, NOW, projectWide)).toBe("in_progress")
  })
})

describe("planUnitShortfall", () => {
  it("counts text's outstanding set once — untranslated cells are a subset of unvalidated ones", () => {
    // Six to translate and thirty-four to validate is not forty cells of work
    // plus another six. It is forty cells that are not yet validated, six of
    // which are not yet written, so `worst` says 40 and never 46.
    expect(planUnitShortfall(counts(100, 94, 60), false)).toEqual({
      toTranslate: 6,
      toValidate: 34,
      toRecord: 0,
      toAudioValidate: 0,
      worst: 40,
    })
  })

  it("clamps every term, so takes that outrun the denominator never go negative", () => {
    // Real data, not a hypothetical: the projection counts takes on structural
    // cells, and the AQU-1083 policy subtracts those cells from totalCount with
    // no structural_audio_count to subtract from audioCount. A book whose
    // headings were voiced comes back with MORE audio than cells. Unclamped,
    // total − audio is negative, the row reads "-12 takes to record", and the
    // unit sails under any threshold because someone recorded its headings.
    const overRecorded = counts(100, 100, 10, 112, 0)
    const s = planUnitShortfall(overRecorded, true)
    expect(s.toRecord).toBe(0)
    for (const term of [s.toTranslate, s.toValidate, s.toRecord, s.toAudioValidate, s.worst]) {
      expect(term).toBeGreaterThanOrEqual(0)
    }
    // And it is still judged on the ninety unvalidated cells it really has.
    expect(s.worst).toBe(90)
    expect(planUnitStatus(overRecorded, NOW, new Set(["f1"]))).toBe("in_progress")
  })
})

describe("planShortfallParts", () => {
  it("leads with translation, because the validation queue is blocked on it", () => {
    expect(planShortfallParts(planUnitShortfall(counts(100, 94, 60), false))).toEqual([
      { kind: "translate", count: 6 },
      { kind: "validate", count: 34 },
    ])
  })

  it("drops a zero term rather than saying '0 cells to translate'", () => {
    expect(planShortfallParts(planUnitShortfall(counts(100, 100, 66), false))).toEqual([
      { kind: "validate", count: 34 },
    ])
  })

  it("stops at two parts, so a row can never grow a third clause", () => {
    // Text and audio debt at once: the recording term is real and is still cut,
    // because the row has room for "6 to translate · 34 to validate" and no more.
    const s = planUnitShortfall(counts(100, 94, 60, 88, 0), true)
    expect(s.toRecord).toBe(12)
    expect(planShortfallParts(s).map((p) => p.kind)).toEqual(["translate", "validate"])
  })

  it("names recording on its own when the text is finished and the takes are not", () => {
    expect(planShortfallParts(planUnitShortfall(counts(100, 100, 100, 40, 0), true))).toEqual([
      { kind: "record", count: 60 },
    ])
  })

  it("is empty when there is nothing left — this is what renders as 'Nothing left'", () => {
    expect(planShortfallParts(planUnitShortfall(shortBy(100, 0), false))).toEqual([])
  })
})

describe("sortNearlyComplete", () => {
  // Least left first. The ordinary comparator cannot produce this order: it
  // sorts by target date, so the book with nothing left but a date in December
  // would sit BELOW one still ninety cells short but due next week. The dates
  // here are deliberately in the opposite order to the shortfalls.
  const none = shortBy(1500, 0, { fileId: "none", fileName: "None left", targetDate: "2026-12-01" })
  const three = shortBy(1500, 3, { fileId: "three", fileName: "Three left", targetDate: "2026-11-01" })
  const ninety = shortBy(1500, 90, { fileId: "ninety", fileName: "Ninety left", targetDate: "2026-09-10" })

  it("has all three in the group at all — ninety is exactly six percent of 1,500", () => {
    expect(planNearlyCompleteThreshold(1500)).toBe(90)
    for (const u of [none, three, ninety]) expect(planUnitStatus(u, NOW)).toBe("nearly_complete")
  })

  it("puts the least-left first regardless of target date", () => {
    expect(sortNearlyComplete([ninety, none, three], new Set<string>()).map((u) => u.fileId))
      .toEqual(["none", "three", "ninety"])
  })

  it("is the comparator groupPlanUnits actually reaches for on this group", () => {
    const groups = groupPlanUnits([ninety, none, three], NOW)
    expect(groups.map((g) => g.status)).toEqual(["nearly_complete"])
    expect(groups[0].units.map((u) => u.fileId)).toEqual(["none", "three", "ninety"])
  })
})

describe("the status vocabulary", () => {
  /**
   * The one place the union can be enumerated at runtime, and tsc DOES check
   * this literal: a status added to PlanUnitStatus and forgotten here fails to
   * compile. That is what lets the assertions below speak for the whole union.
   * PLAN_GROUP_ORDER is a plain array and gets no such check.
   */
  const EVERY_STATUS: Record<PlanUnitStatus, true> = {
    done: true,
    overdue: true,
    soon: true,
    nearly_complete: true,
    in_progress: true,
    not_started: true,
  }

  it("lists every status in PLAN_GROUP_ORDER exactly once", () => {
    // A status missing from the array never renders at all, and plan-view's
    // isPlanUnitStatus derives fold persistence from the same array, so the
    // folds silently stop restoring too. Listed twice, its units render twice.
    expect([...PLAN_GROUP_ORDER].sort()).toEqual(Object.keys(EVERY_STATUS).sort())
    expect(new Set(PLAN_GROUP_ORDER).size).toBe(PLAN_GROUP_ORDER.length)
  })

  it("puts Nearly complete under the two date-driven groups and above the rest", () => {
    expect([...PLAN_GROUP_ORDER]).toEqual([
      "overdue",
      "soon",
      "nearly_complete",
      "in_progress",
      "not_started",
      "done",
    ])
  })

  it("gives every status a label key, under the namespace every plan surface reads", () => {
    for (const s of PLAN_GROUP_ORDER) {
      expect(PLAN_STATUS_LABEL_KEY[s]).toMatch(/^org\.projectOverview\.plan\./)
    }
    // Named exactly, because the row, the inspector and the summary pills all
    // reach for this one key and a rename here silently blanks three surfaces.
    expect(PLAN_STATUS_LABEL_KEY.nearly_complete).toBe("org.projectOverview.plan.statusNearlyComplete")
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

  it("emits all six groups in the declared order when a project has one of each", () => {
    // Deliberately handed to it in the reverse of the answer, so the order
    // comes from PLAN_GROUP_ORDER and not from the caller's array.
    const rows = [
      unit({ fileId: "1", doneAt: NOW, doneBy: "r" }),
      unit({ fileId: "2" }),
      unit({ fileId: "3", filledCount: 5 }),
      shortBy(100, 2, { fileId: "4" }),
      unit({ fileId: "5", targetDate: "2026-09-06", filledCount: 1 }),
      unit({ fileId: "6", targetDate: "2026-08-01" }),
    ]
    expect(groupPlanUnits(rows, NOW).map((g) => g.status)).toEqual([...PLAN_GROUP_ORDER])
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
    expect(planSummary(rows, NOW)).toEqual({
      total: 6, done: 2, overdue: 1, inFlight: 2, nearlyComplete: 0,
    })
  })

  it("is all zeroes for an empty plan", () => {
    expect(planSummary([], NOW)).toEqual({
      total: 0, done: 0, overdue: 0, inFlight: 0, nearlyComplete: 0,
    })
  })

  it("counts nearly complete apart from in flight, so the two pills never double up", () => {
    const rows = [
      unit({ fileId: "1", filledCount: 5 }),
      shortBy(100, 2, { fileId: "2" }),
    ]
    expect(planSummary(rows, NOW)).toEqual({
      total: 2, done: 0, overdue: 0, inFlight: 1, nearlyComplete: 1,
    })
  })

  it("buckets sum to the unit count — it is an if/else chain, not an exhaustive map", () => {
    // A status added to the union and forgotten in planSummary falls out of
    // every bucket, and the numbers above the board quietly shrink with nothing
    // to say so. Every unit here is STARTED, because not_started is deliberately
    // in no bucket at all — the next test pins that, and it is the reason this
    // sum is a claim about started units rather than about every row.
    const rows = [
      unit({ fileId: "1", doneAt: NOW, doneBy: "r" }),
      unit({ fileId: "2", targetDate: "2026-08-01", filledCount: 1 }),
      unit({ fileId: "3", targetDate: "2026-09-06", filledCount: 1 }),
      unit({ fileId: "4", filledCount: 5 }),
      shortBy(100, 2, { fileId: "5" }),
      counts(1000, 1000, 1000, 1000, 0, { fileId: "6" }),
    ]
    const s = planSummary(rows, NOW)
    expect(s).toEqual({ total: 6, done: 1, overdue: 1, inFlight: 2, nearlyComplete: 2 })
    expect(s.done + s.overdue + s.inFlight + s.nearlyComplete).toBe(s.total)
  })

  it("counts an untouched unit in the total and in no bucket at all", () => {
    // Not started has no pill by design — "2 of 6 done" already implies it —
    // so the sum above holds for started units and not for the whole board.
    expect(planSummary([unit()], NOW)).toEqual({
      total: 1, done: 0, overdue: 0, inFlight: 0, nearlyComplete: 0,
    })
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

  it("still asks for a date on a nearly-complete unit", () => {
    // AQU-1278. The note previously answered no_target for in_progress only,
    // which blanked the line beside the inspector's pill for exactly the units
    // this feature is about — and a nearly-finished unit with no date is the
    // one a planner most wants to put a date on.
    const almost = { ...base, filledCount: 10, validatedCount: 8 }
    expect(planUnitStatus(almost, NOW)).toBe("nearly_complete")
    expect(planUnitNote(almost, NOW)).toEqual({ kind: "no_target" })
  })

  it("has nothing to add about a nearly-complete unit that already has a date", () => {
    const planned = { ...base, filledCount: 10, validatedCount: 8, targetDate: "2026-12-01" }
    expect(planUnitStatus(planned, NOW)).toBe("nearly_complete")
    expect(planUnitNote(planned, NOW)).toBeNull()
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

describe("sortUnitsInGroup is a total order", () => {
  const mk = (sectionKey: string, fileName: string): PlanUnit => ({
    fileId: fileName, fileName, sectionKey,
    totalCount: 1, filledCount: 0, validatedCount: 0,
    audioCount: 0, audioValidatedCount: 0, lastEditAt: null,
    targetDate: null, doneAt: null, doneBy: null,
  })

  it("puts books before files rather than cycling between them", () => {
    // The cycle this pins: Genesis < Exodus by canonical ordinal,
    // Exodus < "Fdoc" by label, "Fdoc" < Genesis by label. With that
    // comparator the answer depended on the input order.
    const gen = mk("GEN", "Bible")
    const exo = mk("EXO", "Bible")
    const doc = mk("", "Fdoc")
    const a = sortUnitsInGroup([gen, exo, doc]).map((u) => u.sectionKey || u.fileName)
    const b = sortUnitsInGroup([doc, exo, gen]).map((u) => u.sectionKey || u.fileName)
    const c = sortUnitsInGroup([exo, doc, gen]).map((u) => u.sectionKey || u.fileName)
    expect(a).toEqual(["GEN", "EXO", "Fdoc"])
    expect(b).toEqual(a)
    expect(c).toEqual(a)
  })

  it("still orders books canonically and files by name", () => {
    const out = sortUnitsInGroup([
      mk("", "Zeta"), mk("EXO", "Bible"), mk("", "Alpha"), mk("GEN", "Bible"),
    ]).map((u) => u.sectionKey || u.fileName)
    expect(out).toEqual(["GEN", "EXO", "Alpha", "Zeta"])
  })
})
