import { describe, it, expect } from "vitest"
import {
  composeDeduplicated,
  customSystemPromptText,
  DEFAULT_SYSTEM_PROMPT,
  instructionsPromptBlock,
  resolveTranslationInstructions,
  TRANSLATION_INSTRUCTIONS_MAX_CHARS,
} from "./translation-instructions"
import { validateSettingsKeyValue } from "./project-settings-keys"

const brief = (over: Record<string, unknown> = {}) => ({
  version: 1,
  updatedAt: "2026-01-01",
  updatedBy: "u",
  parameters: {},
  freeformNotes: "",
  l2Markdown: "",
  l1Summary: null,
  l1GeneratedAt: null,
  l1ModelId: null,
  ...over,
})

describe("customSystemPromptText (AQU-2342)", () => {
  it("reads the current and earlier default templates as nothing the team wrote", () => {
    expect(customSystemPromptText(DEFAULT_SYSTEM_PROMPT)).toBe("")
    expect(customSystemPromptText("")).toBe("")
    expect(customSystemPromptText(undefined)).toBe("")
    expect(customSystemPromptText(
      "You are a translation assistant. Translate from {sourceLanguage} to {targetLanguage}. Output ONLY the translation, nothing else. Do not include explanations, notes, or the original text.",
    )).toBe("")
    // List renumbering and spacing do not hide a template line.
    expect(customSystemPromptText("3.   Translate only into {targetLanguage}.")).toBe("")
  })

  it("keeps only the lines the team added to the template", () => {
    const edited = DEFAULT_SYSTEM_PROMPT.replace(
      "Output rules (strictly enforced):",
      "Always use the formal 'you'.\nOutput rules (strictly enforced):",
    )
    expect(customSystemPromptText(edited)).toBe("Always use the formal 'you'.")
    expect(customSystemPromptText("Use plain words for children.")).toBe("Use plain words for children.")
  })
})

describe("composeDeduplicated", () => {
  it("drops blanks, exact and contained duplicates, and lets a fuller wording replace in place", () => {
    expect(composeDeduplicated(["A b", " a  B ", "", "c"])).toBe("A b\n\nc")
    expect(composeDeduplicated(["Use formal register.", "x", "Use formal register. Avoid slang."]))
      .toBe("Use formal register. Avoid slang.\n\nx")
    expect(composeDeduplicated(["Avoid slang everywhere.", "avoid slang"])).toBe("Avoid slang everywhere.")
  })
})

describe("resolveTranslationInstructions", () => {
  it("returns the stored text and ignores every legacy source", () => {
    expect(resolveTranslationInstructions(
      { translationInstructions: "  Mine.  ", systemPrompt: "Old.", translationBrief: brief({ l1Summary: "Brief." }) },
      { projectBriefText: "Legacy." },
    )).toBe("Mine.")
  })

  it("treats a stored blank as an explicit none", () => {
    expect(resolveTranslationInstructions(
      { translationInstructions: "", systemPrompt: "Old." },
      { projectBriefText: "Legacy." },
    )).toBe("")
  })

  it("migrates on read: brief summary, custom prompt text, instruction entries, legacy brief — de-duplicated", () => {
    const settings = {
      translationBrief: brief({ l1Summary: "Translate for teenagers. Prefer everyday words." }),
      systemPrompt: DEFAULT_SYSTEM_PROMPT + "\nNever transliterate divine names.",
      livingMemoryEntries: [
        { id: "1", kind: "instruction", text: "Prefer everyday words.", createdAt: "", author: "" },
        { id: "2", kind: "standard", text: "Ignored standard.", createdAt: "", author: "" },
        { id: "3", kind: "instruction", text: "Keep verse numbers.", createdAt: "", author: "" },
      ],
    }
    expect(resolveTranslationInstructions(settings, { projectBriefText: "Keep verse numbers." })).toBe(
      "Translate for teenagers. Prefer everyday words.\n\nNever transliterate divine names.\n\nKeep verse numbers.",
    )
  })

  it("renders brief sections as prose when no summary was generated", () => {
    expect(resolveTranslationInstructions({
      translationBrief: brief({ parameters: { audience: "Rural adults", literalness: "Meaning-based" }, freeformNotes: "No footnotes." }),
    })).toBe("Audience / addressees: Rural adults\nLevel of literalness: Meaning-based\nNo footnotes.")
  })

  it("is empty for a project with nothing, or only the default prompt", () => {
    expect(resolveTranslationInstructions(null)).toBe("")
    expect(resolveTranslationInstructions({ systemPrompt: DEFAULT_SYSTEM_PROMPT, livingMemoryEntries: "junk" })).toBe("")
  })

  it("caps the composed text", () => {
    const long = "x".repeat(TRANSLATION_INSTRUCTIONS_MAX_CHARS + 50)
    expect(resolveTranslationInstructions({ systemPrompt: long })).toHaveLength(TRANSLATION_INSTRUCTIONS_MAX_CHARS)
  })
})

describe("instructionsPromptBlock + settings key", () => {
  it("titles non-blank text and is empty otherwise", () => {
    expect(instructionsPromptBlock(" Be brief. ")).toBe("Project instructions (follow these):\nBe brief.")
    expect(instructionsPromptBlock("  ")).toBe("")
    expect(instructionsPromptBlock(null)).toBe("")
  })

  it("PatchSettings accepts a string within the cap and refuses one past it", () => {
    expect(validateSettingsKeyValue("translationInstructions", "Be brief.")).toBeNull()
    expect(validateSettingsKeyValue("translationInstructions", null)).toBeNull()
    expect(validateSettingsKeyValue("translationInstructions", 3)).toMatch(/expects string/)
    expect(validateSettingsKeyValue("translationInstructions", "x".repeat(TRANSLATION_INSTRUCTIONS_MAX_CHARS + 1)))
      .toMatch(/longer than 8000/)
  })
})
