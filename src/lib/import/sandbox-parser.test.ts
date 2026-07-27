import { describe, expect, it, vi } from "vitest"
import {
  IMPORT_SANDBOX_PARSE_URL,
  MAX_SANDBOX_IMPORT_UNITS,
  parseUnknownFileInSandbox,
} from "./sandbox-parser"

interface TestResponse {
  classification: {
    category: string
    confidence: number
    explanation: string
    recipe: {
      version: number
      id: string
      name: string
      inputFormat: string
      strategy: string
      config: Record<string, unknown>
      proposedBy: string
      program: { language: string; source: string; sha256: string }
    }
  }
  units: Array<Record<string, unknown>>
}

const PROGRAM_DIGEST = "75647432e95756afa4fc7e8ddcad9b38d4fb92fe16198f813b80f561a176a925"

function validResponse(): TestResponse {
  const digest = PROGRAM_DIGEST
  return {
    classification: {
      category: "scripture",
      confidence: 0.93,
      explanation: "A custom scripture table with explicit structural rows.",
      recipe: {
        version: 1,
        id: `sandbox-${digest.slice(0, 32)}`,
        name: "Legacy scripture table",
        inputFormat: "legacy-binary",
        strategy: "sandbox-program",
        config: { outputSchema: "aquilla-import-units-v1", programSha256: digest },
        proposedBy: "ai",
        program: { language: "python", source: "print('parser')", sha256: digest },
      },
    },
    units: [
      { sourceText: "The beginning", targetText: "Le commencement", type: "heading", globalReferences: ["GEN 1:1"] },
      { sourceText: "In the beginning", type: "verse", globalReferences: ["GEN 1:1"] },
    ],
  }
}

describe("sandbox-assisted import parser client", () => {
  it("sends exact file bytes to the dedicated import route and preserves normalized fields", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(validResponse()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))
    const file = new File([new Uint8Array([0, 1, 2, 3])], "legacy odd.bin", { type: "application/octet-stream" })

    const result = await parseUnknownFileInSandbox(file, {
      identityToken: "identity-token",
      projectId: "project/one",
      sourceLanguage: "English",
      targetLanguage: "French",
      fetchImpl,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${IMPORT_SANDBOX_PARSE_URL}/project%2Fone`)
    expect(init?.body).toBe(file)
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer identity-token",
      "X-Artifact-Name": "legacy%20odd.bin",
      "X-Source-Language": "English",
      "X-Target-Language": "French",
    })
    expect(result.strings[0]).toMatchObject({
      original: "The beginning",
      translated: "Le commencement",
      type: "heading",
      group: "GEN 1:h:1",
      section: "GEN 1",
      globalReferences: ["GEN 1:h:1"],
      metadata: {
        aquillaStructuralContext: { globalReferences: ["GEN 1:1"] },
        aquillaRecipe: { recipeId: `sandbox-${PROGRAM_DIGEST.slice(0, 32)}`, record: 1 },
      },
    })
    expect(result.strings[1]).toMatchObject({ type: "verse", globalReferences: ["GEN 1:1"] })
    expect(result.classification.recipe.program?.source).toBe("print('parser')")
  })

  it("rejects malformed provenance and oversized output before preview", async () => {
    const malformed = validResponse()
    malformed.classification.recipe.program.sha256 = "not-a-digest"
    await expect(parseUnknownFileInSandbox(new File(["x"], "x.odd"), {
      identityToken: "token",
      projectId: "p",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(malformed), { status: 200 })),
    })).rejects.toThrow(/invalid recipe provenance/)

    const oversizedProgram = validResponse()
    oversizedProgram.classification.recipe.program.source = "x".repeat(60_001)
    await expect(parseUnknownFileInSandbox(new File(["x"], "x.odd"), {
      identityToken: "token",
      projectId: "p",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(oversizedProgram), { status: 200 })),
    })).rejects.toThrow(/invalid recipe provenance/)

    const invalidTiming = validResponse()
    invalidTiming.units = [{ sourceText: "Cue", type: "cue", start: 4, end: 2 }]
    await expect(parseUnknownFileInSandbox(new File(["x"], "x.odd"), {
      identityToken: "token",
      projectId: "p",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(invalidTiming), { status: 200 })),
    })).rejects.toThrow(/invalid timing/)

    const invalidOptionalField = validResponse()
    invalidOptionalField.units = [{ sourceText: "Cell", targetText: 42 }]
    await expect(parseUnknownFileInSandbox(new File(["x"], "x.odd"), {
      identityToken: "token",
      projectId: "p",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(invalidOptionalField), { status: 200 })),
    })).rejects.toThrow(/invalid target text/)

    const oversized = validResponse()
    oversized.units = Array.from({ length: MAX_SANDBOX_IMPORT_UNITS + 1 }, () => ({ sourceText: "x" }))
    await expect(parseUnknownFileInSandbox(new File(["x"], "x.odd"), {
      identityToken: "token",
      projectId: "p",
      fetchImpl: vi.fn(async () => new Response(JSON.stringify(oversized), { status: 200 })),
    })).rejects.toThrow(/more than .* cells/)
  })
})
