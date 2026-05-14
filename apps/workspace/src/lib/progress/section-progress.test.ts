import { describe, it, expect } from "vitest"
import { computeSectionProgress } from "./section-progress"

function mkCell(
  id: string,
  section: string,
  translated: string,
  validators: string[],
  audioUrl?: string,
) {
  return {
    id,
    group: "irrelevant",
    section,
    translated,
    activeValidators: validators,
    audioUrl,
  } as any
}

describe("computeSectionProgress", () => {
  it("returns empty for no cells", () => {
    expect(computeSectionProgress([], 1)).toEqual([])
  })

  it("counts textCompleted as cells with non-empty translated text", () => {
    const cells = [
      mkCell("a", "C1", "hello", []),
      mkCell("b", "C1", "", []),
      mkCell("c", "C1", "   ", []),
    ]
    const [section] = computeSectionProgress(cells, 1)
    expect(section.label).toBe("C1")
    expect(section.textCompleted).toBe(33) // 1/3 rounded
  })

  it("counts textValidated as cells with activeValidators.length >= validationCount", () => {
    const cells = [
      mkCell("a", "C1", "hi", ["alice"]),
      mkCell("b", "C1", "hi", ["alice", "bob"]),
      mkCell("c", "C1", "hi", []),
      mkCell("d", "C1", "hi", ["alice", "bob", "carol"]),
    ]
    const [section] = computeSectionProgress(cells, 2)
    expect(section.textValidated).toBe(50) // 2/4 meet threshold of 2
  })

  it("validationLevels[i] = % cells with more than i distinct validators", () => {
    const cells = [
      mkCell("a", "C1", "hi", ["alice"]),              // 1 validator
      mkCell("b", "C1", "hi", ["alice", "bob"]),       // 2 validators
      mkCell("c", "C1", "hi", ["alice", "bob", "carol"]), // 3 validators
      mkCell("d", "C1", "hi", []),                     // 0 validators
    ]
    const [section] = computeSectionProgress(cells, 3)
    // level 0: 3/4 have >= 1 validator = 75
    // level 1: 2/4 have >= 2 validators = 50
    // level 2: 1/4 have >= 3 validators = 25
    expect(section.textValidationLevels).toEqual([75, 50, 25])
  })

  it("includes all sections in file order", () => {
    const cells = [
      mkCell("a", "C1", "x", []),
      mkCell("b", "C2", "y", []),
    ]
    const result = computeSectionProgress(cells, 1)
    expect(result.map(s => s.label)).toEqual(["C1", "C2"])
  })

  it("hasAudio true when any cell has audioUrl", () => {
    const cells = [
      mkCell("a", "C1", "x", [], "url.wav"),
      mkCell("b", "C1", "y", []),
    ]
    const [section] = computeSectionProgress(cells, 1)
    expect(section.hasAudio).toBe(true)
  })

  it("hasAudio false when no cell has audio", () => {
    const cells = [mkCell("a", "C1", "x", [])]
    const [section] = computeSectionProgress(cells, 1)
    expect(section.hasAudio).toBe(false)
  })

  it("audio stub fields are 0 / empty until audio data exists", () => {
    const cells = [mkCell("a", "C1", "x", [])]
    const [section] = computeSectionProgress(cells, 1)
    expect(section.audioCompleted).toBe(0)
    expect(section.audioValidated).toBe(0)
    expect(section.audioValidationLevels).toEqual([])
  })
})
