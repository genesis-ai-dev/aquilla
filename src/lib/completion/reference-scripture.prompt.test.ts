// AQU-1573: the reference verse has to reach the prompt, labelled, as text to
// REPRODUCE rather than as another few-shot example.
import { describe, expect, it } from "vitest"
import {
  buildPrompt,
  buildReferenceScriptureBlock,
  type ReferenceScriptureEntry,
} from "./prompt-build"

const VANDYCK: ReferenceScriptureEntry = {
  canonicalRef: "ISA 40:25",
  citedAs: "Isaiah 40:25",
  versionId: "arb-vandyck",
  versionLabel: "Smith-Van Dyck (1865), Arabic",
  text: "فَبِمَنْ تُشَبِّهُونَنِي وَأُسَاوَى، يَقُولُ الْقُدُّوسُ.",
}

describe("buildReferenceScriptureBlock", () => {
  it("labels each verse with the citation and the version it came from", () => {
    const block = buildReferenceScriptureBlock([VANDYCK])
    expect(block).toContain("Isaiah 40:25 (Smith-Van Dyck (1865), Arabic):")
    expect(block).toContain(VANDYCK.text)
  })

  it("tells the model to reproduce the wording rather than translate the quotation", () => {
    expect(buildReferenceScriptureBlock([VANDYCK])).toContain("VERBATIM")
  })

  it("renders nothing for no entries, blank text, or absent input", () => {
    expect(buildReferenceScriptureBlock([])).toBe("")
    expect(buildReferenceScriptureBlock(undefined)).toBe("")
    expect(buildReferenceScriptureBlock([{ ...VANDYCK, text: "   " }])).toBe("")
  })

  it("collapses a repeated (version, verse) pair", () => {
    const block = buildReferenceScriptureBlock([VANDYCK, VANDYCK])
    expect(block.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1)
  })

  it("keeps the same verse from two different versions", () => {
    const block = buildReferenceScriptureBlock([
      VANDYCK,
      { ...VANDYCK, versionId: "eng-kjv", versionLabel: "KJV", text: "To whom then will ye liken me" },
    ])
    expect(block.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(2)
  })
})

describe("buildPrompt with a reference Bible", () => {
  const base = {
    sourceLanguage: "English",
    targetLanguage: "Arabic",
    systemPrompt: "Translate from {sourceLanguage} to {targetLanguage}.",
    sourceText: 'As Isaiah 40:25 asks, "To whom will you compare me?"',
    examples: [],
  }

  it("injects the block into the user message immediately before the live source", () => {
    const [, user] = buildPrompt({ ...base, referenceScripture: [VANDYCK] })
    expect(user.content).toContain(VANDYCK.text)
    expect(user.content.indexOf(VANDYCK.text)).toBeLessThan(user.content.lastIndexOf("Source:"))
    expect(user.content.endsWith("Translation:")).toBe(true)
  })

  it("leaves the system prompt alone — the verse is per-cell data, not instructions", () => {
    const [system] = buildPrompt({ ...base, referenceScripture: [VANDYCK] })
    expect(system.content).not.toContain(VANDYCK.text)
  })

  it("renders reference Scripture before the footnote pre-source block", () => {
    const [, user] = buildPrompt({
      ...base,
      referenceScripture: [VANDYCK],
      preSourceBlock: "Footnotes in the source:",
    })
    expect(user.content.indexOf(VANDYCK.text)).toBeLessThan(
      user.content.indexOf("Footnotes in the source:"),
    )
  })

  it("changes nothing when the project has no reference Bible", () => {
    const without = buildPrompt(base)
    expect(buildPrompt({ ...base, referenceScripture: [] })).toEqual(without)
    expect(buildPrompt({ ...base, referenceScripture: [{ ...VANDYCK, text: "" }] })).toEqual(without)
  })
})
