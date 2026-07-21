import { describe, expect, it, vi } from "vitest"
import {
  applyDeclarativeRecipe,
  classifyAndParseUnknownText,
  sniffKnownTextFile,
  type AiImportClassification,
  type AiRecipeConfig,
} from "./ai-recipe"

function classification(
  config: AiRecipeConfig,
  category: AiImportClassification["category"] = "other",
): AiImportClassification {
  return {
    category,
    confidence: 0.91,
    explanation: "Structured records",
    recipe: {
      version: 1,
      id: "recipe-test",
      name: "Test records",
      inputFormat: "test",
      strategy: "records",
      config,
      proposedBy: "ai",
    },
  }
}

describe("AI-assisted declarative import recipes", () => {
  it("applies a delimited bilingual recipe and keeps headings unnumbered", () => {
    const result = applyDeclarativeRecipe([
      "kind,reference,source,target,speaker",
      "heading,,Creation,La création,",
      "verse,GEN 1:1,In the beginning,Au commencement,Narrator",
    ].join("\n"), classification({
      recordMode: "delimited",
      delimiter: ",",
      hasHeader: true,
      sourceField: "source",
      targetField: "target",
      referenceField: "reference",
      typeField: "kind",
      speakerField: "speaker",
    }, "scripture"))

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      original: "Creation",
      translated: "La création",
      type: "heading",
    })
    expect(result[0].globalReferences).toBeUndefined()
    expect(result[1]).toMatchObject({
      original: "In the beginning",
      translated: "Au commencement",
      type: "verse",
      globalReferences: ["GEN 1:1"],
      speaker: "Narrator",
    })
  })

  it("applies JSON-array paths and subtitle timestamps without executing code", () => {
    const source = JSON.stringify({ cues: [{
      text: "Hello",
      translation: "Bonjour",
      start: "00:00:01.250",
      end: "00:00:03.000",
    }] })
    const [cue] = applyDeclarativeRecipe(source, classification({
      recordMode: "json-array",
      recordsPath: "cues",
      sourceField: "text",
      targetField: "translation",
      startField: "start",
      endField: "end",
      timeUnit: "timestamp",
    }, "subtitles"))

    expect(cue).toMatchObject({
      original: "Hello",
      translated: "Bonjour",
      type: "cue",
      start: 1.25,
      end: 3,
    })
  })

  it("accepts named delimiters from the model and applies the recipe to the whole file", async () => {
    const longFirstRecord = "x".repeat(12_100)
    const file = new File([`${longFirstRecord}\nsecond record`], "records.odd", { type: "text/plain" })
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        category: "document",
        confidence: 0.84,
        explanation: "One record per line",
        recipe: {
          name: "Line records",
          inputFormat: "unknown-lines",
          config: { recordMode: "line", delimiter: "tab" },
        },
      }) } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }))

    const parsed = await classifyAndParseUnknownText(file, {
      identityToken: "identity-token",
      projectId: "project-1",
      fetchImpl,
    })

    expect(parsed.strings).toHaveLength(2)
    expect(parsed.strings[1].original).toBe("second record")
    expect(parsed.classification.recipe.config.delimiter).toBe("\t")
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const request = fetchImpl.mock.calls[0][1] as RequestInit
    expect(request.headers).toMatchObject({ Authorization: "Bearer identity-token" })
    expect(String(request.body)).not.toContain("second record")
  })

  it("rejects malformed model output instead of guessing a structure", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      choices: [{ message: { content: "not json" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }))

    await expect(classifyAndParseUnknownText(
      new File(["one\ntwo"], "records.odd"),
      { identityToken: "token", projectId: "p", fetchImpl },
    )).rejects.toThrow("malformed JSON")
  })
})

describe("deterministic content sniffing", () => {
  it.each([
    ["mystery.data", "\\id GEN\n\\c 1\n\\v 1 Text", "usfm"],
    ["mystery.data", "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi", "vtt"],
    ["mystery.data", "<xliff version=\"2.0\"></xliff>", "xliff"],
    ["mystery.data", "<tmx version=\"1.4\"></tmx>", "tmx"],
  ])("recognizes known content before asking AI (%s)", (_name, contents, expected) => {
    expect(sniffKnownTextFile(contents)).toBe(expected)
  })
})
