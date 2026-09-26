// AQU-1148 regression guard: an export must never present unvalidated draft or
// source-language filler as approved translation.
//
// AQU-1423 regression guard: and it must never contain a cell somebody HID.
// Hiding is not a mode the person chooses in this dialog — it is a property of
// the cell — so a parked cell is out of `current` exports too, and the
// round-trip injectors must be handed no translation for it (which is how they
// are told to leave the client's own words alone).

import { describe, it, expect } from "vitest"
import {
  DEFAULT_EXPORT_CONTENT_MODE,
  hasHiddenCells,
  hiddenRoundTripRemovals,
  isHiddenFromExport,
  isValidatedForExport,
  scopeCellsForExport,
  scopeRoundTripCells,
  validatedOnly,
} from "./validation-scope"

interface TestCell {
  id: string
  status: "empty" | "unvalidated" | "validated"
  translated: string
  hidden?: boolean
  metadata?: Record<string, unknown> | null
}

const cell = (id: string, status: TestCell["status"], translated: string): TestCell =>
  ({ id, status, translated })

/** A cell parked with "Hide cell" (AQU-1422). Validated on purpose: the whole
 *  point is that hiding overrules the validation rule rather than riding it. */
const hiddenCell = (id: string, translated: string, metadata?: Record<string, unknown>): TestCell =>
  ({ id, status: "validated", translated, hidden: true, ...(metadata ? { metadata } : {}) })

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

describe("hidden cells (AQU-1423)", () => {
  /** Approved, parked, and approved again — so a bug that drops the wrong row
   *  is visible in the ids rather than only in the count. */
  const WITH_HIDDEN: TestCell[] = [
    cell("a", "validated", "Primero"),
    hiddenCell("h", "PARKED LINE"),
    cell("c", "validated", "Tercero"),
  ]

  it("reads the flag off the cell, and treats an absent flag as visible", () => {
    expect(isHiddenFromExport({ status: "validated", hidden: true })).toBe(true)
    expect(isHiddenFromExport({ status: "validated", hidden: false })).toBe(false)
    // Every row of every project that has never hidden anything.
    expect(isHiddenFromExport({ status: "validated" })).toBe(false)
  })

  it("omits a hidden cell from a text export in BOTH modes", () => {
    // The mode is the person's choice about drafts; hiding is not. A parked
    // cell that survived `current` would ship in every default export.
    expect(scopeCellsForExport(WITH_HIDDEN, "current").map((c) => c.id)).toEqual(["a", "c"])
    expect(scopeCellsForExport(WITH_HIDDEN, "validated-only").map((c) => c.id)).toEqual(["a", "c"])
  })

  it("still returns the caller's own array when nothing is parked", () => {
    // Load-bearing: `current` exports must stay byte-identical on the
    // overwhelming majority of files, which have nothing hidden at all.
    expect(scopeCellsForExport(MIXED, "current")).toBe(MIXED)
    expect(scopeRoundTripCells(MIXED, "current")).toBe(MIXED)
  })

  it("clears a hidden cell's translation for the round-trip injectors", () => {
    // It KEEPS its place — the package's paragraphs are located through the
    // array — but carries nothing to inject, which is how docx/pptx/idml are
    // told to leave the client's own words alone.
    const scoped = scopeRoundTripCells(WITH_HIDDEN, "current")
    expect(scoped.map((c) => c.id)).toEqual(["a", "h", "c"])
    expect(scoped.map((c) => c.translated)).toEqual(["Primero", "", "Tercero"])
  })

  it("does not mutate the caller's cells when clearing a hidden one", () => {
    // The same array feeds the fidelity warnings and the IDML telemetry.
    const cells = [hiddenCell("h", "PARKED LINE")]
    scopeRoundTripCells(cells, "current")
    expect(cells[0]!.translated).toBe("PARKED LINE")
  })

  it("hands docx/pptx the hidden cells' locators so the paragraph is DROPPED", () => {
    // Clearing the translation alone is not enough for a package injector: it
    // would leave the client's ORIGINAL words in the delivered document, so the
    // parked paragraph ships in the source language (AQU-752 on the Codex side).
    const locator = { aquillaImport: { sourceLocator: { memberPath: "word/document.xml", blockPath: "3" } } }
    const removals = hiddenRoundTripRemovals([
      cell("a", "validated", "Primero"),
      hiddenCell("h", "PARKED LINE", locator),
    ])
    expect(removals).toEqual([{ metadata: locator }])
  })

  it("gives a locator-less hidden cell a null metadata rather than dropping it", () => {
    // The package walk decides what a null locator means; silently omitting the
    // entry here would hide that decision from it.
    expect(hiddenRoundTripRemovals([hiddenCell("h", "x")])).toEqual([{ metadata: null }])
  })

  it("answers whether the file has anything parked, for the dialog's note", () => {
    expect(hasHiddenCells(MIXED)).toBe(false)
    expect(hasHiddenCells(WITH_HIDDEN)).toBe(true)
  })
})
