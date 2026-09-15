// Context readiness — the advisory checklist and the one part of it that is
// actually enforced.
//
// WHY these tests: `computeStartBlockers` is a GATE (AQU-827). Every other
// readiness signal degrades the draft; these two make it unsteerable, so the
// run is refused instead. A regression here fails open and silently — autopilot
// would happily bill for fluent, generic output on a project nobody has told it
// anything about, which is precisely the failure the gate exists to prevent.
// So the floor is pinned from both sides: what must block, and what must NOT
// (one answered brief field is enough — this is a floor, not the `ready` bar).

import { describe, it, expect } from "vitest"
import { computeContextReadiness, computeStartBlockers } from "./readiness"
import type { ProjectContext } from "./project-context"

const bare: ProjectContext = { briefParameters: {}, concepts: [], authoredRules: [] }

const ready: ProjectContext = {
  ...bare,
  sourceLanguage: "en",
  targetLanguage: "sw",
  briefParameters: { purpose: "Community reading" },
}

describe("computeStartBlockers", () => {
  it("blocks a project with no languages and no brief on both counts", () => {
    expect(computeStartBlockers(bare)).toEqual(["languages", "brief"])
  })

  it("clears a project that has both languages and one answered brief field", () => {
    expect(computeStartBlockers(ready)).toEqual([])
  })

  it("blocks when only one side of the language pair is set", () => {
    expect(computeStartBlockers({ ...ready, targetLanguage: undefined })).toEqual(["languages"])
    expect(computeStartBlockers({ ...ready, sourceLanguage: undefined })).toEqual(["languages"])
  })

  it("treats whitespace-only languages and brief answers as unset", () => {
    expect(computeStartBlockers({ ...ready, sourceLanguage: "   " })).toContain("languages")
    expect(computeStartBlockers({ ...ready, briefParameters: { purpose: "  " } })).toContain("brief")
  })

  it("accepts a generated L1 summary in place of answered fields", () => {
    const summarised = { ...ready, briefParameters: {}, projectBriefL1: "Clear-language NT" }
    expect(computeStartBlockers(summarised)).toEqual([])
  })

  it("is a floor, not the readiness bar — one field clears the gate while the checklist still asks for more", () => {
    const readiness = computeContextReadiness({
      context: ready,
      validatedExamples: 0,
      untranslatedCells: 40,
    })
    expect(readiness.startBlockers).toEqual([])
    // The brief item is still only "partial" and examples are still missing:
    // the gate opening is not a claim that the project is well set up.
    expect(readiness.items.find((i) => i.id === "brief")?.level).toBe("partial")
    expect(readiness.ready).toBe(false)
  })

  it("reports the blockers on the readiness payload the client hydrates from", () => {
    const readiness = computeContextReadiness({
      context: bare,
      validatedExamples: 0,
      untranslatedCells: 40,
    })
    expect(readiness.startBlockers).toEqual(["languages", "brief"])
  })
})
