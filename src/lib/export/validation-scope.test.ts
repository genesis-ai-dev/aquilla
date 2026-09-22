// AQU-1148 regression guard: an export must never present unvalidated draft or
// source-language filler as approved translation.

import { describe, it, expect } from "vitest"
import {
  DEFAULT_EXPORT_CONTENT_MODE,
  isValidatedForExport,
  scopeCellsForExport,
  scopeRoundTripCells,
  validatedOnly,
} from "./validation-scope"

interface TestCell {
  id: string
  status: "empty" | "unvalidated" | "validated"
  translated: string
}

const cell = (id: string, status: TestCell["status"], translated: string): TestCell =>
  ({ id, status, translated })

/** A file with one of each: approved, unreviewed draft, and untranslated. */
const MIXED: TestCell[] = [
  cell("a", "validated", "Aprobado"),
  cell("b", "unvalidated", "Borrador sin revisar"),
  cell("c", "empty", ""),
]

const ALL_VALIDATED: TestCell[] = [
  cell("a", "validated", "Uno"),
  cell("b", "validated", "Dos"),
]

describe("export content mode", () => {
  it("defaults to today's behaviour — validated-only is a deliberate choice", () => {
    expect(DEFAULT_EXPORT_CONTENT_MODE).toBe("current")
    expect(validatedOnly(DEFAULT_EXPORT_CONTENT_MODE)).toBe(false)
    expect(validatedOnly("validated-only")).toBe(true)
  })

  it("reads validation off the cell's authoritative status (AQU-279)", () => {
    expect(isValidatedForExport({ status: "validated" })).toBe(true)
    expect(isValidatedForExport({ status: "unvalidated" })).toBe(false)
    expect(isValidatedForExport({ status: "empty" })).toBe(false)
  })
})

describe("scopeCellsForExport (file-building text exporters)", () => {
  it("passes every cell through unchanged under 'current'", () => {
    expect(scopeCellsForExport(MIXED, "current")).toBe(MIXED)
  })

  it("OMITS non-validated cells so no source-language filler can replace them", () => {
    // The hazard this guards: the monolingual exporters fall back to
    // `effectiveSourceText(cell)` when `translated` is blank. Blanking rather
    // than dropping would put source text in an approved-only file.
    const scoped = scopeCellsForExport(MIXED, "validated-only")
    expect(scoped.map((c) => c.id)).toEqual(["a"])
    expect(scoped.every((c) => c.status === "validated")).toBe(true)
  })

  it("exports a fully-validated file identically in both modes", () => {
    expect(scopeCellsForExport(ALL_VALIDATED, "validated-only")).toEqual(
      scopeCellsForExport(ALL_VALIDATED, "current"),
    )
  })
})

describe("scopeRoundTripCells (docx / pptx / idml injectors)", () => {
  it("passes every cell through unchanged under 'current'", () => {
    expect(scopeRoundTripCells(MIXED, "current")).toBe(MIXED)
  })

  it("keeps every cell but clears the translation of non-validated ones", () => {
    // The injectors locate paragraphs through the cell array and leave a
    // paragraph alone when it has no translation — so a cleared cell keeps the
    // client's ORIGINAL words rather than shipping an unreviewed draft.
    const scoped = scopeRoundTripCells(MIXED, "validated-only")
    expect(scoped.map((c) => c.id)).toEqual(["a", "b", "c"])
    expect(scoped.map((c) => c.translated)).toEqual(["Aprobado", "", ""])
  })

  it("does not mutate the caller's cells — they still feed warnings + telemetry", () => {
    scopeRoundTripCells(MIXED, "validated-only")
    expect(MIXED[1]!.translated).toBe("Borrador sin revisar")
  })

  it("exports a fully-validated file identically in both modes", () => {
    expect(scopeRoundTripCells(ALL_VALIDATED, "validated-only")).toEqual(
      scopeRoundTripCells(ALL_VALIDATED, "current"),
    )
  })
})
