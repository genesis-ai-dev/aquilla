/**
 * FRO-287 — Unit tests for the pure collision-detection helper.
 *
 * WHY each test matters:
 *   - bookCode match: consultants re-import the same Paratext zip; the USFM \id
 *     tag is the primary identity — name can vary by locale but bookCode is stable.
 *   - name match: non-USFM formats (DOCX, TXT…) have no bookCode so we fall back
 *     to normalized name.
 *   - fresh project: zero collisions when there are no existing files — the fast
 *     path must NOT produce false positives.
 *   - case/whitespace tolerance: "gen" == "GEN", " Genesis " == "Genesis".
 *   - disjoint import: different books in same project → zero collisions.
 */

import { describe, it, expect } from "vitest"
import { detectCollisions } from "./import-collision"

describe("detectCollisions — bookCode primary", () => {
  it("matches when incoming bookCode equals existing bookCode (case-insensitive)", () => {
    const result = detectCollisions(
      [{ name: "Genesis", bookCode: "GEN" }],
      [{ name: "Genesis", bookCode: "gen" }],
    )
    expect(result).toHaveLength(1)
    expect(result[0].bookCode).toBe("GEN")
    expect(result[0].existingName).toBe("Genesis")
  })

  it("matches when bookCode differs in case and whitespace", () => {
    const result = detectCollisions(
      [{ name: "Genesis", bookCode: " GEN " }],
      [{ name: "Genesis", bookCode: " gen " }],
    )
    expect(result).toHaveLength(1)
  })

  it("matches all colliding books in a Paratext import", () => {
    const incoming = [
      { name: "Genesis", bookCode: "GEN" },
      { name: "Exodus", bookCode: "EXO" },
      { name: "Ruth", bookCode: "RUT" },
    ]
    const existing = [
      { name: "Genesis", bookCode: "GEN" },
      { name: "Ruth", bookCode: "RUT" },
    ]
    const result = detectCollisions(incoming, existing)
    expect(result).toHaveLength(2)
    expect(result.map((r) => r.bookCode)).toEqual(expect.arrayContaining(["GEN", "RUT"]))
  })

  it("does NOT collide when bookCodes are different", () => {
    const result = detectCollisions(
      [{ name: "Exodus", bookCode: "EXO" }],
      [{ name: "Genesis", bookCode: "GEN" }],
    )
    expect(result).toHaveLength(0)
  })
})

describe("detectCollisions — name fallback (no bookCode)", () => {
  it("falls back to name match when bookCode absent", () => {
    const result = detectCollisions(
      [{ name: "Project Notes" }],
      [{ name: "Project Notes" }],
    )
    expect(result).toHaveLength(1)
    expect(result[0].existingName).toBe("Project Notes")
  })

  it("name match is case- and whitespace-insensitive", () => {
    const result = detectCollisions(
      [{ name: "  project notes  " }],
      [{ name: "Project Notes" }],
    )
    expect(result).toHaveLength(1)
  })

  it("does NOT match on different names (no bookCode)", () => {
    const result = detectCollisions(
      [{ name: "Chapter 1" }],
      [{ name: "Chapter 2" }],
    )
    expect(result).toHaveLength(0)
  })
})

describe("detectCollisions — fresh project (no existing files)", () => {
  it("returns empty array for empty existing list", () => {
    const result = detectCollisions(
      [{ name: "Genesis", bookCode: "GEN" }],
      [],
    )
    expect(result).toHaveLength(0)
  })

  it("returns empty array for empty incoming list", () => {
    const result = detectCollisions(
      [],
      [{ name: "Genesis", bookCode: "GEN" }],
    )
    expect(result).toHaveLength(0)
  })
})

describe("detectCollisions — mixed bookCode presence", () => {
  it("uses bookCode when present on incoming, ignores name collision", () => {
    // Incoming has bookCode "EXO"; existing has same name "Genesis" but code "EXO"
    // → matches by code, not by name.
    const result = detectCollisions(
      [{ name: "Exodus", bookCode: "EXO" }],
      [{ name: "Genesis", bookCode: "EXO" }],  // same code, different name
    )
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("Exodus")
    expect(result[0].existingName).toBe("Genesis")
  })

  it("falls through to name when incoming has bookCode but existing does not", () => {
    // Existing file has no bookCode (e.g. non-USFM project file); match by name.
    const result = detectCollisions(
      [{ name: "Genesis", bookCode: "GEN" }],
      [{ name: "genesis" }],  // no bookCode, but same normalized name
    )
    expect(result).toHaveLength(1)
  })

  it("no false positive when incoming has bookCode but no existing match", () => {
    const result = detectCollisions(
      [{ name: "Leviticus", bookCode: "LEV" }],
      [{ name: "Genesis", bookCode: "GEN" }],
    )
    expect(result).toHaveLength(0)
  })
})
