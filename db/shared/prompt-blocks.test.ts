import { describe, it, expect } from "vitest"
import {
  assemblePromptSections,
  checkHintLine,
  checksHintBlock,
  CHECKS_BLOCK_HEADING,
  guidanceSections,
  MAX_TERM_NOTE_CHARS,
  PROMPT_SECTION_ORDER,
  runDirectionsBlock,
  terminologyBlock,
  TERMINOLOGY_BLOCK_HEADING,
} from "./prompt-blocks"

describe("checksHintBlock", () => {
  it("lists rules (description first, else pattern prose), then style rules, then profile slots", () => {
    const block = checksHintBlock({
      rules: [
        { name: "a", description: "Never use the colloquial form.", enabled: true, check: { type: "target-forbids", targetPattern: "x" } },
        { name: "b", description: "", enabled: true, check: { type: "source-requires-target", sourcePattern: "grace", targetPattern: "gracia" } },
        { name: "off", description: "Disabled.", enabled: false, check: { type: "target-forbids", targetPattern: "y" } },
        { id: "term:c1:approved", name: "Term", description: "term rule", enabled: true, check: { type: "source-requires-target", sourcePattern: "a", targetPattern: "b" } },
        { name: "builtin", description: "Generic spacing check.", enabled: true, check: { type: "builtin", checkId: "x" } },
      ],
      styleInstructions: ["Keep parallel lines apart.", "Never use the colloquial form."],
      languageProfile: { measures: "convert" },
    })
    expect(block).toBe(
      `${CHECKS_BLOCK_HEADING}\n` +
        "- Never use the colloquial form.\n" +
        '- When the source contains "grace", the translation must include "gracia".\n' +
        "- Keep parallel lines apart.\n" +
        '- Measures (convert, transliterate or mixed): "convert"',
    )
  })

  it("is empty when nothing can be hinted", () => {
    expect(checksHintBlock({})).toBe("")
    expect(checkHintLine({ check: { type: "builtin" } })).toBe("")
  })
})

describe("terminologyBlock", () => {
  it("renders preferred, alternates, forbidden and a clipped note on one line per term", () => {
    const note = "n".repeat(MAX_TERM_NOTE_CHARS + 20)
    const block = terminologyBlock([
      { sourceTerm: "spirit", approved: ["espíritu", "aliento"], forbidden: ["fantasma"], notes: note },
      { sourceTerm: "empty", approved: [], forbidden: [] },
      { sourceTerm: "ghost", approved: [], forbidden: ["fantasma"] },
    ])
    const lines = block.split("\n")
    expect(lines[0]).toBe(TERMINOLOGY_BLOCK_HEADING)
    expect(lines[1]).toBe(
      `- "spirit" → "espíritu" (also acceptable: "aliento"). Do NOT use "fantasma". Note: ${"n".repeat(MAX_TERM_NOTE_CHARS)}…`,
    )
    expect(lines[2]).toBe('- "ghost": Do NOT use "fantasma".')
    expect(lines).toHaveLength(3)
    expect(terminologyBlock([])).toBe("")
  })
})

describe("runDirectionsBlock", () => {
  it("bullets each direction under a heading that ranks them below checks", () => {
    expect(runDirectionsBlock(["Keep it short.", " "])).toMatch(/^This run's directions .*never the checks or terminology\):\n- Keep it short\.$/)
    expect(runDirectionsBlock("  ")).toBe("")
    expect(runDirectionsBlock(undefined)).toBe("")
  })
})

describe("assemblePromptSections", () => {
  it("joins sections in the one canonical order regardless of key order, skipping blanks", () => {
    const out = assemblePromptSections({
      output: "OUT",
      directions: "DIR",
      context: "CTX",
      examples: "EX",
      terminology: "TERMS",
      checks: "",
      instructions: "INS",
      role: "ROLE",
    })
    expect(out).toBe("ROLE\n\nINS\n\nTERMS\n\nEX\n\nCTX\n\nDIR\n\nOUT")
    expect(PROMPT_SECTION_ORDER).toEqual(["role", "instructions", "checks", "terminology", "examples", "context", "directions", "output"])
  })

  it("guidanceSections builds instructions, checks and terminology the shared way", () => {
    const g = guidanceSections({
      instructions: "Be brief.",
      rules: [{ description: "No slang.", enabled: true }],
      terms: [{ sourceTerm: "Moses", approved: ["Moisés"], forbidden: [] }],
    })
    expect(g.instructions).toBe("Project instructions (follow these):\nBe brief.")
    expect(g.checks).toBe(`${CHECKS_BLOCK_HEADING}\n- No slang.`)
    expect(g.terminology).toBe(`${TERMINOLOGY_BLOCK_HEADING}\n- "Moses" → "Moisés".`)
  })
})
