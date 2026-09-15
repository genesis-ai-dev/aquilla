import { describe, it, expect } from "vitest"
import { planRowsToCsv, planCsvFilename } from "./plan-csv"
import type { PlanUnit } from "@/lib/plan/plan-status"

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
