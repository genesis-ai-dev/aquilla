import { describe, it, expect } from "vitest"
import { planRowsToCsv, planCsvFilename } from "./plan-csv"
import { PLAN_GROUP_ORDER, type PlanUnit } from "@/lib/plan/plan-status"

const NOW = Date.parse("2026-09-02T09:00:00Z")

function unit(over: Partial<PlanUnit> = {}): PlanUnit {
  return {
    fileId: "f1", fileName: "Mark", sectionKey: "",
    totalCount: 400, filledCount: 288, validatedCount: 124,
    audioCount: 176, audioValidatedCount: 48, lastEditAt: null,
    targetDate: null, doneAt: null, doneBy: null,
    ...over,
  } as PlanUnit
}

describe("planRowsToCsv", () => {
  it("leads with the columns a manager reports on", () => {
    const [header] = planRowsToCsv([], NOW).split("\r\n")
    expect(header).toBe(
      "Unit,Status,Target date,Marked done,Marked done by,Translated %,Validated %,Audio recorded %,Audio validated %,Last activity",
    )
  })

  it("writes percentages, not raw counts", () => {
    // The denominator is deliberately NOT 100. With 100 cells a percentage
    // equals its own numerator, so this assertion passed just as happily
    // against `pct = (part) => part` — it named the property without testing
    // it. 288/400 = 72, 124/400 = 31, 176/400 = 44, 48/400 = 12.
    const [, row] = planRowsToCsv([unit()], NOW).split("\r\n")
    expect(row).toContain("72,31,44,12")
    expect(row).not.toContain("288")
  })

  it("names a book unit by its book name", () => {
    const [, row] = planRowsToCsv([unit({ sectionKey: "GEN", fileName: "Whole Bible" })], NOW).split("\r\n")
    expect(row.startsWith("Genesis,")).toBe(true)
  })

  it("carries the status and the Done provenance", () => {
    const csv = planRowsToCsv([unit({ doneAt: Date.parse("2026-08-20T00:00:00Z"), doneBy: "randall" })], NOW)
    expect(csv).toContain("Done,,2026-08-20,randall")
  })

  it("marks an overdue unit as overdue", () => {
    const csv = planRowsToCsv([unit({ targetDate: "2026-08-01" })], NOW)
    expect(csv).toContain("Overdue,2026-08-01")
  })

  it("names every status in the board's own words", () => {
    // One unit per group, given in PLAN_GROUP_ORDER. The length check against
    // that array is the part that earns its keep: STATUS_TEXT is an exhaustive
    // Record, so a seventh status would compile the moment someone named it
    // there and this test would still pass while nobody had ever read the word
    // it exports. Tying the count to the group order makes the omission fail.
    const units = [
      unit({ fileId: "f1", fileName: "Late", targetDate: "2026-08-01" }),
      // NOW is 2026-09-02T09:00Z and a date's AoE end is that date + 36h, so
      // the 5th expires on the 6th at noon — four days out, inside the window.
      unit({ fileId: "f2", fileName: "Close", targetDate: "2026-09-05" }),
      // 400 cells, so the window is max(ceil(400 × 0.06), 7) = 24. Twelve cells
      // await validation and ten await a take: the worse medium is inside it.
      unit({ fileId: "f3", fileName: "Almost", filledCount: 400, validatedCount: 388, audioCount: 390 }),
      unit({ fileId: "f4", fileName: "Under way" }),
      unit({ fileId: "f5", fileName: "Untouched", filledCount: 0, validatedCount: 0, audioCount: 0 }),
      unit({ fileId: "f6", fileName: "Signed off", doneAt: NOW, doneBy: "randall" }),
    ]
    const statuses = planRowsToCsv(units, NOW)
      .split("\r\n")
      .slice(1)
      .map((row) => row.split(",")[1])
    expect(statuses).toEqual([
      "Overdue",
      "Due soon",
      "Nearly complete",
      "In progress",
      "Not started",
      "Done",
    ])
    expect(statuses).toHaveLength(PLAN_GROUP_ORDER.length)
  })

  it("judges audio per file, as the board does, and not per row", () => {
    // Both books live in one whole-Bible file and both are fully translated and
    // validated. Genesis is recorded, Exodus has not been touched by a mic — so
    // the file is one that carries audio, and Exodus is short by four hundred
    // takes. Asking the ROW instead of the file (which is what happens when the
    // audio-file set is not passed down) makes Exodus look text-only, judges it
    // on the text it has finished, and exports "Nearly complete" for a book
    // with no recording at all — disagreeing with the board about the same row.
    const done = { totalCount: 400, filledCount: 400, validatedCount: 400 }
    const csv = planRowsToCsv(
      [
        unit({ fileId: "bible", fileName: "Whole Bible", sectionKey: "GEN", ...done, audioCount: 400 }),
        unit({ fileId: "bible", fileName: "Whole Bible", sectionKey: "EXO", ...done, audioCount: 0 }),
      ],
      NOW,
    )
    const [, genesis, exodus] = csv.split("\r\n")
    expect(genesis).toContain("Genesis,Nearly complete,")
    expect(exodus).toContain("Exodus,In progress,")
  })

  it("measures a dubbing unit's audio against its cue sheet, like the board", () => {
    // 646 subtitle cells, a 100-cue sheet, 90 takes: the board reads 90%, and
    // the export must say the same number — measured against the file's own
    // cell count it would read 13% and the export would be the one believed.
    const [, row] = planRowsToCsv([unit({
      fileName: "Episode 1", totalCount: 646, filledCount: 646, validatedCount: 646,
      audioTotalCount: 100, audioCount: 90, audioValidatedCount: 0,
    })], NOW).split("\r\n")
    const cols = row.split(",")
    expect(cols[7]).toBe("90")
    expect(cols[8]).toBe("0")
  })

  it("quotes a name containing a comma rather than splitting the row", () => {
    const csv = planRowsToCsv([unit({ fileName: 'Episode 3, "Joy"' })], NOW)
    expect(csv).toContain('"Episode 3, ""Joy"""')
    expect(csv.split("\r\n")).toHaveLength(2)
  })

  it("leaves unset dates empty rather than writing a fake one", () => {
    const [, row] = planRowsToCsv([unit()], NOW).split("\r\n")
    // target date, marked-done date and marked-done-by are all blank.
    expect(row).toBe("Mark,In progress,,,,72,31,44,12,")
  })
})

describe("planCsvFilename", () => {
  it("makes a safe filename from the project name", () => {
    expect(planCsvFilename("Tok Pisin — Gospels")).toBe("Tok-Pisin-Gospels-plan.csv")
  })
  it("falls back when the name has nothing usable", () => {
    expect(planCsvFilename("   ")).toBe("project-plan.csv")
  })
})
