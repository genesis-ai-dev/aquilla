// FRO-280 — Post-migration tests: section-progress now consumes the server
// `validated` flag rather than re-deriving the threshold client-side.
//
// Finding (audit F-P2, §3.6 / F-B1, §3.5):
//   `section-progress.ts:48-49` was THE ONLY place in the client that honored
//   `validationCount` locally.  FRO-280 replaces that with:
//     if (cell.validated !== undefined ? cell.validated : vCount >= validationCount)
//   so the server-projected threshold gate is authoritative.
//
// These tests were characterization tests (frozen as "CHARACTERIZATION (audit F-P2)")
// that documented the old threshold-aware local derivation.  After FRO-280 the
// tests are flipped: they now document the new server-flag-first behavior.
//
// The multi-level bar (textValidationLevels) still derives from
// activeValidators.length — it is a visual breakdown, not the threshold gate.

import { describe, it, expect } from "vitest"
import { computeSectionProgress } from "./section-progress"

function mkCell(
  id: string,
  section: string,
  translated: string,
  validators: string[],
  validated?: boolean,
) {
  return {
    id,
    group: "irrelevant",
    section,
    translated,
    activeValidators: validators,
    validated,
  } as any
}

// ── Server-flag-first derivation (post FRO-280) ───────────────────────────────

describe("FRO-280: computeSectionProgress consumes server validated flag", () => {
  // When the server flag is present, validationCount is irrelevant for textValidated.
  it("cell with validated=true counts as validated regardless of validationCount", () => {
    const cells = [
      mkCell("a", "C1", "hi", ["alice"], true),          // flag=true, 1 validator
      mkCell("b", "C1", "hi", ["alice", "bob"], false),  // flag=false, 2 validators
      mkCell("c", "C1", "hi", [], false),                // flag=false, 0 validators
    ]
    // With validationCount=2: only cell-a has validated=true → 1/3 ≈ 33
    const [section] = computeSectionProgress(cells, 2)
    expect(section.textValidated).toBe(33)
  })

  it("cell with validated=false does NOT count even when activeValidators.length >= validationCount", () => {
    const cells = [
      mkCell("a", "C1", "hi", ["alice", "bob"], false), // 2 validators but flag=false
    ]
    const [section] = computeSectionProgress(cells, 2)
    expect(section.textValidated).toBe(0)
  })

  // Agreement test: N=2 project — all four surfaces must agree.
  // Section-progress produces the same result as useHealth.deriveAuxStats
  // (which counts cell.status==="validated", itself derived from validated flag).
  it("N=2 fixture: cells whose server validated=true count; others do not", () => {
    // Simulate a seeded N=2 project: 3 cells, 2 are threshold-validated by server.
    const cells = [
      mkCell("a", "C1", "hi", [], true),   // flag=true (meets N=2 threshold)
      mkCell("b", "C1", "hi", [], true),   // flag=true (meets N=2 threshold)
      mkCell("c", "C1", "hi", [], false),  // flag=false (only 1 endorsement)
    ]
    const [section] = computeSectionProgress(cells, 2)
    expect(section.textValidated).toBe(67) // 2/3 ≈ 67
  })

  // Fallback: when validated is absent, falls back to validator-count comparison.
  it("falls back to activeValidators.length >= validationCount when validated is absent", () => {
    const cells = [
      mkCell("a", "C1", "hi", ["alice"]),         // no validated field, 1 validator
      mkCell("b", "C1", "hi", ["alice", "bob"]),  // no validated field, 2 validators
      mkCell("c", "C1", "hi", []),                // no validated field, 0 validators
    ]
    // With validationCount=2: only cell-b meets threshold via fallback → 1/3 ≈ 33
    const [section] = computeSectionProgress(cells, 2)
    expect(section.textValidated).toBe(33)
  })

  it("with validated=undefined and validationCount=1, any cell with ≥1 validator counts", () => {
    const cells = [
      mkCell("a", "C1", "hi", ["alice"]), // no validated field, 1 validator ≥ 1
      mkCell("b", "C1", "hi", []),        // no validated field, 0 validators
    ]
    const [section] = computeSectionProgress(cells, 1)
    expect(section.textValidated).toBe(50)
  })

  // Key: server flag=true on a cell that has 0 activeValidators still counts.
  // (projection may not return individual validator lists)
  it("validated=true with no activeValidators still counts as validated", () => {
    const cells = [
      mkCell("a", "C1", "hi", [], true),  // server says validated, no validator list
      mkCell("b", "C1", "hi", [], false),
    ]
    const [section] = computeSectionProgress(cells, 2)
    expect(section.textValidated).toBe(50)
  })

  it("validated=false with validationCount=0 does NOT count (flag wins over fallback)", () => {
    // Old behavior (characterization): validationCount=0 made ALL cells count
    // because vCount >= 0 is always true. New behavior: server flag=false wins.
    const cells = [mkCell("a", "C1", "hi", [], false)]
    const [section] = computeSectionProgress(cells, 0)
    expect(section.textValidated).toBe(0)
  })
})

// ── textValidationLevels multi-bar (unchanged — still from activeValidators) ──

describe("textValidationLevels still derives from activeValidators.length (visual breakdown)", () => {
  it("produces one level per validationCount, each = % cells with > i validators", () => {
    const cells = [
      mkCell("a", "C1", "hi", ["alice"], true),                         // 1 validator
      mkCell("b", "C1", "hi", ["alice", "bob"], true),                  // 2 validators
      mkCell("c", "C1", "hi", ["alice", "bob", "carol"], true),         // 3 validators
      mkCell("d", "C1", "hi", [], false),                               // 0 validators
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
      mkCell("a", "C1", "hi", ["alice"], true),
      mkCell("b", "C1", "hi", [], false),
    ]
    const [section] = computeSectionProgress(cells, 1)
    expect(section.textValidationLevels).toHaveLength(1)
    expect(section.textValidationLevels[0]).toBe(50) // 1/2 have >0 validators
  })
})
