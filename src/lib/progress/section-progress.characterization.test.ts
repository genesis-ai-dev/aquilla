// FRO-268 — Characterization tests: freeze section-progress threshold-aware
// derivation as it exists today.
//
// Finding (audit F-P2, §3.6):
//   `section-progress.ts:48-49` is THE ONLY place in the client that honors
//   `validationCount` (the project threshold). It derives "validated" as:
//     vCount >= validationCount
//   where `vCount = cell.activeValidators?.length`.
//
//   All other progress surfaces (projection counters, portfolio endpoint,
//   useHealth.deriveAuxStats) ignore validationCount and use the server-side
//   `cells.validated` flag, which is itself COUNT(*) > 0 (always 1-validator).
//   This creates 4 surfaces that can disagree on "validated %".
//
// CHARACTERIZATION (audit F-P2): FRO-280 migrates this to the server flag,
// removing the client-side threshold re-derivation from computeSectionProgress.
// These tests document the current threshold-aware logic so the change is
// intentional and auditable.

import { describe, it, expect } from "vitest"
import { computeSectionProgress } from "./section-progress"

function mkCell(
  id: string,
  section: string,
  translated: string,
  validators: string[],
) {
  return {
    id,
    group: "irrelevant",
    section,
    translated,
    activeValidators: validators,
  } as any
}

// ── Threshold-aware derivation ────────────────────────────────────────────────

describe("CHARACTERIZATION (audit F-P2): computeSectionProgress uses validationCount locally", () => {
  // CHARACTERIZATION (audit F-P2): FRO-280 migrates this to the server flag.
  // Today the sidebar is the ONLY client surface that is threshold-aware.
  it("textValidated counts cells where activeValidators.length >= validationCount", () => {
    const cells = [
      mkCell("a", "C1", "hi", ["alice"]),         // 1 validator
      mkCell("b", "C1", "hi", ["alice", "bob"]),   // 2 validators
      mkCell("c", "C1", "hi", []),                 // 0 validators
    ]
    // With validationCount=2: only cell-b meets threshold
    const [section] = computeSectionProgress(cells, 2)
    expect(section.textValidated).toBe(33) // 1/3 ≈ 33
  })

  // CHARACTERIZATION (audit F-P2): with validationCount=1 the client agrees
  // with the server's COUNT(*) > 0 behavior — this is the common case where
  // the disagreement is invisible.
  it("with validationCount=1, any cell that has ≥1 validator is counted as validated", () => {
    const cells = [
      mkCell("a", "C1", "hi", ["alice"]),
      mkCell("b", "C1", "hi", []),
    ]
    const [section] = computeSectionProgress(cells, 1)
    expect(section.textValidated).toBe(50) // 1/2
  })

  // CHARACTERIZATION (audit F-P2): with validationCount=2 the sidebar will
  // show a LOWER validated% than ProjectOverview (which uses the server flag,
  // which flips at 1 endorsement).
  it("with validationCount=2, sidebar disagrees with server flag (which uses COUNT>0)", () => {
    // Three cells, each with exactly 1 validator.
    // Server flag: all 3 are validated=1 (COUNT(*) > 0).
    // Sidebar (this function, validationCount=2): none of them qualify.
    const cells = [
      mkCell("a", "C1", "hi", ["alice"]),
      mkCell("b", "C1", "hi", ["bob"]),
      mkCell("c", "C1", "hi", ["carol"]),
    ]
    // CHARACTERIZATION: sidebar reports 0% validated even though the server
    // flag says 100%.  FRO-280 will remove this client re-derivation; after
    // the fix both surfaces should use the server flag (and FRO-279 will make
    // the server flag itself threshold-aware).
    const [section] = computeSectionProgress(cells, 2)
    expect(section.textValidated).toBe(0)
  })

  // Boundary: a cell with exactly validationCount validators is counted
  it("cell with exactly validationCount validators counts as validated", () => {
    const cells = [mkCell("a", "C1", "hi", ["alice", "bob"])]
    const [section] = computeSectionProgress(cells, 2)
    expect(section.textValidated).toBe(100)
  })

  // Boundary: a cell with one fewer than threshold does NOT count
  it("cell with validationCount-1 validators does NOT count as validated", () => {
    const cells = [mkCell("a", "C1", "hi", ["alice"])]
    const [section] = computeSectionProgress(cells, 2)
    expect(section.textValidated).toBe(0)
  })

  it("validationCount=0 makes every cell count as validated (vCount >= 0 is always true)", () => {
    // The levelCap is clamped to at least 1 (for the levels array), but the
    // textValidated check at line 49 uses the raw validationCount:
    //   if (vCount >= validationCount) validated++
    // So vCount >= 0 is always true — even cells with zero validators are
    // counted as validated when validationCount=0.
    const cells = [mkCell("a", "C1", "hi", [])]
    const [section] = computeSectionProgress(cells, 0)
    // CHARACTERIZATION: 0 validators, validationCount=0 → validated=100%
    expect(section.textValidated).toBe(100)
  })

  it("validationCount=1 with no validators gives 0% validated", () => {
    const cells = [
      mkCell("a", "C1", "hi", []),
      mkCell("b", "C1", "hi", []),
    ]
    const [section] = computeSectionProgress(cells, 1)
    expect(section.textValidated).toBe(0)
  })
})

// ── textValidationLevels multi-bar ────────────────────────────────────────────

describe("CHARACTERIZATION (audit F-P2): textValidationLevels encodes multi-endorsement breakdown", () => {
  // CHARACTERIZATION (audit F-P2): FRO-280 migrates this to the server flag.
  // For now the multi-level bar is the sidebar's local computation.
  it("produces one level per validationCount, each = % cells with > i validators", () => {
    const cells = [
      mkCell("a", "C1", "hi", ["alice"]),               // 1 validator
      mkCell("b", "C1", "hi", ["alice", "bob"]),         // 2 validators
      mkCell("c", "C1", "hi", ["alice", "bob", "carol"]), // 3 validators
      mkCell("d", "C1", "hi", []),                       // 0 validators
    ]
    // validationCount=3 → 3 levels
    // level[0] = cells with >0 validators = 3/4 = 75
    // level[1] = cells with >1 validators = 2/4 = 50
    // level[2] = cells with >2 validators = 1/4 = 25
    const [section] = computeSectionProgress(cells, 3)
    expect(section.textValidationLevels).toHaveLength(3)
    expect(section.textValidationLevels[0]).toBe(75)
    expect(section.textValidationLevels[1]).toBe(50)
    expect(section.textValidationLevels[2]).toBe(25)
  })

  it("with validationCount=1 only one level is produced", () => {
    const cells = [
      mkCell("a", "C1", "hi", ["alice"]),
      mkCell("b", "C1", "hi", []),
    ]
    const [section] = computeSectionProgress(cells, 1)
    expect(section.textValidationLevels).toHaveLength(1)
    expect(section.textValidationLevels[0]).toBe(50) // 1/2 have >0 validators
  })
})
