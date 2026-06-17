// src/lib/brief/brief-generator.test.ts
import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/completion/completion-service", () => ({
  complete: vi.fn(),
}))
import { complete } from "@/lib/completion/completion-service"
import { generateL1Summary } from "./brief-generator"
import { emptyBrief } from "./brief"
import { L1_MAX_CHARS } from "./schema"
import type { CompletionSettings } from "@/lib/parsers/types"

const settings = { model: "m", provider: "frontier", maxTokens: 4096, temperature: 0.2 } as unknown as CompletionSettings

describe("generateL1Summary", () => {
  it("sends the assembled L2 to the model and returns its summary", async () => {
    vi.mocked(complete).mockResolvedValue("Translate evangelistically for young readers.")
    const brief = { ...emptyBrief("a"), parameters: { purpose: "Evangelistic", audience: "Youth" } }
    const out = await generateL1Summary(brief, settings, null)
    expect(out).toBe("Translate evangelistically for young readers.")
    const userMsg = vi.mocked(complete).mock.calls[0][0].messages.at(-1)!.content
    expect(userMsg).toContain("Evangelistic") // L2 content fed to the model
  })

  it("truncates an over-long summary to the L1 cap", async () => {
    vi.mocked(complete).mockResolvedValue("x".repeat(L1_MAX_CHARS + 500))
    const out = await generateL1Summary({ ...emptyBrief("a"), parameters: { purpose: "p" } }, settings, null)
    expect(out.length).toBeLessThanOrEqual(L1_MAX_CHARS)
  })
})

import { extractBriefFromDocument, parseExtractedParameters } from "./brief-generator"

describe("parseExtractedParameters", () => {
  it("keeps only known field ids and string values", () => {
    const raw = JSON.stringify({ purpose: "Evangelistic", bogus: "x", audience: 5, keyTerms: "Use 'God'" })
    expect(parseExtractedParameters(raw)).toEqual({ purpose: "Evangelistic", keyTerms: "Use 'God'" })
  })
  it("tolerates code fences and surrounding prose", () => {
    const raw = "Here you go:\n```json\n{\"purpose\":\"P\"}\n```"
    expect(parseExtractedParameters(raw)).toEqual({ purpose: "P" })
  })
  it("returns {} on garbage", () => {
    expect(parseExtractedParameters("not json")).toEqual({})
  })
})

describe("extractBriefFromDocument", () => {
  it("maps a document into the known parameter ids", async () => {
    vi.mocked(complete).mockResolvedValue(JSON.stringify({ purpose: "Study Bible", literalness: "Formal" }))
    const out = await extractBriefFromDocument("Our project is a formal study Bible…", settings, null)
    expect(out).toEqual({ purpose: "Study Bible", literalness: "Formal" })
  })
})

import { draftField } from "./brief-generator"

describe("draftField", () => {
  it("asks the model to draft one field using the other answers as context", async () => {
    vi.mocked(complete).mockResolvedValue("Young, unchurched readers aged 15-25.")
    const out = await draftField("audience", { parameters: { purpose: "Evangelistic" }, freeformNotes: "" }, settings, null)
    expect(out).toBe("Young, unchurched readers aged 15-25.")
    const sys = vi.mocked(complete).mock.calls.at(-1)![0].messages[0].content
    expect(sys).toContain("Audience / addressees") // field label drives the prompt
  })
})
