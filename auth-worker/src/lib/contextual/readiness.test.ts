// Context readiness — the advisory checklist and the one part of it that is
// actually enforced.
//
// WHY these tests: `computeStartBlockers` is a GATE (AQU-827). Every other
// readiness signal degrades the draft; these two make it unsteerable, so the
// run is refused instead. A regression here fails open and silently — autopilot
// would happily bill for fluent, generic output on a project nobody has told it
// anything about, which is precisely the failure the gate exists to prevent.
// So the floor is pinned from both sides: what must block, and what must NOT
// (any non-blank resolved instructions are enough — a floor, not the `ready` bar).

import { describe, it, expect } from "vitest"
import { computeContextReadiness, computeStartBlockers } from "./readiness"
import type { ProjectContext } from "./project-context"
import { resolveTranslationInstructions } from "../../../../db/shared/translation-instructions"

const bare: ProjectContext = {
  translationInstructions: "",
  concepts: [],
  authoredRules: [],
  projectFacts: [],
  languageProfile: {},
}

const ready: ProjectContext = {
  ...bare,
  sourceLanguage: "en",
  targetLanguage: "sw",
  translationInstructions: "Purpose: Community reading",
}

describe("computeStartBlockers", () => {
  it("blocks a project with no languages and no instructions on both counts", () => {
    expect(computeStartBlockers(bare)).toEqual(["languages", "instructions"])
  })

  it("clears a project that has both languages and instructions", () => {
    expect(computeStartBlockers(ready)).toEqual([])
  })

  it("blocks when only one side of the language pair is set", () => {
    expect(computeStartBlockers({ ...ready, targetLanguage: undefined })).toEqual(["languages"])
    expect(computeStartBlockers({ ...ready, sourceLanguage: undefined })).toEqual(["languages"])
  })

  it("treats whitespace-only languages and instructions as unset", () => {
    expect(computeStartBlockers({ ...ready, sourceLanguage: "   " })).toContain("languages")
    expect(computeStartBlockers({ ...ready, translationInstructions: "  " })).toContain("instructions")
  })

  // AQU-2342: the gate reads the RESOLVED instructions, so every legacy source
  // still clears it on read — one answered brief field, a brief summary, a
  // customized copilot prompt, the legacy agent brief — and so does the key.
  it("clears on instructions from any source, stored or composed on read", () => {
    const sources = [
      resolveTranslationInstructions({ translationBrief: { parameters: { purpose: "Community reading" } } }),
      resolveTranslationInstructions({ translationBrief: { l1Summary: "Clear-language NT" } }),
      resolveTranslationInstructions({ systemPrompt: "Always use the formal you." }),
      resolveTranslationInstructions({}, { projectBriefText: "For radio broadcast." }),
      resolveTranslationInstructions({ translationInstructions: "Plain register." }),
    ]
    for (const translationInstructions of sources) {
      expect(computeStartBlockers({ ...ready, translationInstructions })).toEqual([])
    }
    expect(computeStartBlockers({ ...ready, translationInstructions: resolveTranslationInstructions({}) })).toEqual(["instructions"])
  })

  it("is a floor, not the readiness bar — one field clears the gate while the checklist still asks for more", () => {
    const readiness = computeContextReadiness({
      context: ready,
      validatedExamples: 0,
      untranslatedCells: 40,
    })
    expect(readiness.startBlockers).toEqual([])
    // Examples are still missing: the gate opening is not a claim that the
    // project is well set up.
    expect(readiness.items.find((i) => i.id === "examples")?.level).toBe("missing")
    expect(readiness.ready).toBe(false)
  })

  it("reports the blockers on the readiness payload the client hydrates from", () => {
    const readiness = computeContextReadiness({
      context: bare,
      validatedExamples: 0,
      untranslatedCells: 40,
    })
    expect(readiness.startBlockers).toEqual(["languages", "instructions"])
  })
})
