// AQU-2342 phase 2: every drafting path carries the SAME standing-guidance
// blocks, built by db/shared/prompt-blocks.ts, in the ONE section order:
// role → instructions → checks → terminology → examples → context → this
// run's directions (→ the path's output contract).
//
// One project, five paths. Each path is driven with the same guidance and the
// test asserts (a) the instructions, checks and terminology text is byte-equal
// to the copilot's, and (b) the sections appear in the canonical order. The
// DB-backed loading for the draft tool is covered in agent-tools.test.ts;
// Autopilot's loading in contextual-project-context.test.ts.

import { describe, expect, it } from "vitest"
import { buildPrompt } from "../../../src/lib/completion/prompt-build"
import { compileConceptsToRulesCore, type CompileLabels } from "../../../src/lib/terminology/compile-core"
import {
  checksHintBlock,
  CHECKS_BLOCK_HEADING,
  terminologyBlock,
  TERMINOLOGY_BLOCK_HEADING,
} from "../../../db/shared/prompt-blocks"
import { instructionsPromptBlock } from "../../../db/shared/translation-instructions"
import { performSpan } from "../lib/contextual/draft"
import { termGuidanceForSpan, termHints, type Concept } from "../lib/contextual/project-context"
import { createRunBudget } from "../lib/contextual/types"
import { draftJson, pair, scriptedLlm } from "../lib/contextual/test-helpers"
import { draftSystemPrompt, researchSystemPrompt } from "../lib/agent/tools/draft"
import { AliasMap } from "../lib/agent/compress"
import { buildSystemPrompt } from "../lib/agent/schema-card"
import type { LintRule } from "../lib/agent/lint"

const INSTRUCTIONS = "Plain register for rural youth."
const RULE: LintRule = {
  id: "r1",
  name: "No slang",
  description: "Never use slang.",
  enabled: true,
  check: { type: "target-forbids", targetPattern: "tío" },
}
const STYLE = ["Keep parallel lines on separate lines."]
const PROFILE = { measures: "convert" as const }
const SOURCE = "Moses spoke to the people."
const MOSES: Concept = {
  id: "c-moses",
  sourceTerm: "Moses",
  renderings: [{ rendering: "Moisés", status: "preferred" }],
  notes: "Keep the accent.",
  status: "active",
}
const LABELS: CompileLabels = {
  approvedName: (t) => t,
  approvedDescription: (t) => t,
  forbiddenName: (t) => t,
  forbiddenDescription: (r) => r,
}

const instructions = instructionsPromptBlock(INSTRUCTIONS)
const checks = checksHintBlock({ rules: [RULE], styleInstructions: STYLE, languageProfile: PROFILE })
const terminology = terminologyBlock(termHints(termGuidanceForSpan([MOSES], [SOURCE])))

/** Indexes of `needles` in `text`, each required to be present. */
function positions(text: string, needles: readonly string[]): number[] {
  return needles.map((needle) => {
    const at = text.indexOf(needle)
    expect(at, `missing: ${needle.slice(0, 60)}`).toBeGreaterThanOrEqual(0)
    return at
  })
}

function expectAscending(values: number[]): void {
  expect([...values].sort((a, b) => a - b)).toEqual(values)
}

describe("one guidance, one order — every drafting path", () => {
  it("the shared blocks are what this project should produce", () => {
    expect(instructions).toBe(`Project instructions (follow these):\n${INSTRUCTIONS}`)
    expect(checks).toBe(
      `${CHECKS_BLOCK_HEADING}\n- Never use slang.\n- Keep parallel lines on separate lines.\n- Measures (convert, transliterate or mixed): "convert"`,
    )
    expect(terminology).toBe(`${TERMINOLOGY_BLOCK_HEADING}\n- "Moses" → "Moisés". Note: Keep the accent.`)
  })

  it("copilot (and the prompt preview, which calls the same builder)", () => {
    const [sys, user] = buildPrompt({
      sourceLanguage: "English",
      targetLanguage: "Spanish",
      sourceText: SOURCE,
      examples: [{ source: "EX_SRC", target: "EX_TGT" }],
      precedingContext: [{ source: "PREV_SRC", target: "PREV_TGT" }],
      rules: [
        { ...RULE, check: { type: "target-forbids", targetPattern: "tío" } },
        ...compileConceptsToRulesCore([MOSES], LABELS),
      ],
      styleInstructions: STYLE,
      languageProfile: PROFILE,
      instructions: INSTRUCTIONS,
    })
    expectAscending(positions(sys.content, ["You are a translation assistant", instructions, checks, terminology]))
    // Examples, then context, then the live source: the user message continues the order.
    expectAscending(positions(user.content, ["EX_SRC", "PREV_SRC", `Source: ${SOURCE}`]))
  })

  it("Autopilot performer", async () => {
    const { llm, calls } = scriptedLlm([draftJson([{ i: 1, t: "uno" }])])
    await performSpan({
      sceneBrief: { id: "sb", spanId: "s", l1Summary: "SCENE", ambiguityRegister: [] },
      pairs: [pair("c1", { source: SOURCE })],
      examples: [{ cellId: "e", source: "EX_SRC", target: "EX_TGT", validated: true }],
      precedingValidated: [pair("c0", { source: "PREV_SRC", target: "PREV_TGT", validated: true })],
      translationInstructions: INSTRUCTIONS,
      rules: [RULE],
      styleInstructions: STYLE,
      languageProfile: PROFILE,
      terms: termGuidanceForSpan([MOSES], [SOURCE]),
      steeringDirections: ["Use vosotros."],
      llm,
      budget: createRunBudget(),
    })
    expectAscending(
      positions(calls[0].system, [
        "You are the PERFORMER",
        instructions,
        checks,
        terminology,
        "EX_SRC",
        "Scene brief: SCENE",
        "PREV_SRC",
        "This run's directions",
        "Output STRICT JSON",
      ]),
    )
    expect(calls[0].user).toContain(SOURCE)
  })

  it("agent draft tool / DraftCells (both passes)", () => {
    const ctx = {
      projectId: "p",
      lane: "",
      aliases: new AliasMap(),
      targetLanguage: "Spanish",
      translationInstructions: INSTRUCTIONS,
      signal: new AbortController().signal,
      sendProgress: () => {},
      addUsage: () => {},
    }
    const guidance = {
      checks,
      terminology,
      examples: "Translation pairs from this project (imitate them):\n[E1] EX_SRC",
      context: "Immediately preceding, validated context:\n[C1] PREV_SRC",
      directions: "This run's directions: - Use vosotros.",
    }
    for (const system of [researchSystemPrompt(ctx, guidance), draftSystemPrompt(ctx, guidance)]) {
      expectAscending(
        positions(system, [
          "You draft for a scripture translation project.",
          instructions,
          checks,
          terminology,
          "EX_SRC",
          "PREV_SRC",
          "This run's directions",
          system.includes("RESEARCH pass") ? "RESEARCH pass" : "GENERATION pass",
        ]),
      )
    }
  })

  it("agent chat: instructions then the checks hint (terms and examples are per line — its draft tool adds them)", () => {
    const system = buildSystemPrompt({
      projectId: "p",
      username: "u",
      roleLevel: 400,
      translationInstructions: INSTRUCTIONS,
      checksHint: checks,
    })
    expectAscending(positions(system, ["You are the Aquilla translation agent", instructions, checks]))
    expect(system.split(instructions)).toHaveLength(2)
  })
})
