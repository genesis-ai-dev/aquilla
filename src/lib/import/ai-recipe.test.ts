import { describe, expect, it, vi } from "vitest"
import {
  applyDeclarativeRecipe,
  classifyAndParseUnknownText,
  MAX_UNKNOWN_TEXT_BYTES,
  readUnknownTextFile,
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

  it("derives a stable recipe id from executable semantics across content edits", async () => {
    const responseBody = JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        category: "document",
        confidence: 0.9,
        explanation: "Line records",
        recipe: {
          name: "Line records",
          inputFormat: "unknown-lines",
          config: { recordMode: "line" },
        },
      }) } }],
    })
    const fetchImpl = vi.fn(async () => new Response(responseBody, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))
    const file = new File(["one\ntwo"], "records.odd", { type: "text/plain" })

    const first = await classifyAndParseUnknownText(file, {
      identityToken: "token",
      projectId: "p",
      fetchImpl,
    })
    const second = await classifyAndParseUnknownText(new File(["one edited\ntwo"], "records.odd"), {
      identityToken: "token",
      projectId: "p",
      fetchImpl,
    })

    expect(first.classification.recipe.id).toMatch(/^ai-[a-f0-9]{32}$/)
    expect(second.classification.recipe.id).toBe(first.classification.recipe.id)
    expect(second.strings.map((cell) => cell.group)).toEqual(first.strings.map((cell) => cell.group))
    expect(first.strings[0]).toMatchObject({
      original: "one",
      translated: "",
      context: "Line records 1",
      type: "text",
    })
    expect(first.strings[0].group).toBe(`${first.classification.recipe.id}:1`)
    expect(first.strings[0].globalReferences).toBeUndefined()
    expect(first.strings[0].speaker).toBeUndefined()
  })

  it("rejects oversized and binary unknown files before invoking AI", async () => {
    const fetchImpl = vi.fn()
    const oversized = {
      name: "huge.odd",
      size: MAX_UNKNOWN_TEXT_BYTES + 1,
      arrayBuffer: vi.fn(),
    } as unknown as File

    await expect(classifyAndParseUnknownText(oversized, {
      identityToken: "token",
      projectId: "p",
      fetchImpl,
    })).rejects.toThrow("too large")
    expect(oversized.arrayBuffer).not.toHaveBeenCalled()

    await expect(classifyAndParseUnknownText(
      new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "binary.odd"),
      { identityToken: "token", projectId: "p", fetchImpl },
    )).rejects.toThrow("appears to be binary")
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("decodes UTF-16 unknown text without misclassifying its NUL bytes", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00])
    const inspected = await readUnknownTextFile(new File([bytes], "utf16.odd"))
    expect(inspected.text.replace(/^\uFEFF/, "")).toBe("Hi")
    expect(inspected.bytes.byteLength).toBe(bytes.byteLength)
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
