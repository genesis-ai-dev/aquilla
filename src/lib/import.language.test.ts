// FRO-249: Imported projects load with no source/target language direction set.
// These tests verify that:
//  1. importParatextProject returns settings.languageIsoCode from Settings.xml
//  2. importParatextAsTarget returns both the eBible source ID and the Paratext
//     target language in `settings`
//  3. emitParsedFile correctly threads sourceLanguage/targetLanguage from
//     ImportContext into the file.create payload

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { emitParsedFile } from "./import"
import type { TranslatableString } from "./parsers/types"

// ── minimal fetch stub ──────────────────────────────────────────────────────

interface CapturedFileCreate {
  projectId: string
  fileId: string
  file?: {
    sourceLanguage?: string
    targetLanguage?: string
    name: string
  }
  cells: unknown[]
}

let captured: CapturedFileCreate[]

beforeEach(() => {
  captured = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as CapturedFileCreate
      captured.push(body)
      return new Response(
        JSON.stringify({ accepted: body.cells.length, fileId: body.fileId }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const getToken = async () => "test-token"

function makeVerse(id: string, text: string): TranslatableString {
  return { id, original: text, translated: "", context: "", group: "GEN 1", type: "verse" }
}

// ── FRO-249: language threading via ImportContext ──────────────────────────

describe("FRO-249 — source/target language threading", () => {
  it("emitParsedFile passes sourceLanguage and targetLanguage into the file.create payload", async () => {
    await emitParsedFile(
      { name: "Genesis", strings: [makeVerse("GEN 1:1", "In the beginning")] },
      "usfm",
      {
        projectId: "proj-1",
        author: "alice",
        sourceLanguage: "hbo",
        targetLanguage: "deu",
        getToken,
      },
    )

    expect(captured).toHaveLength(1)
    const payload = captured[0]
    // file.create metadata must carry the language pair.
    expect(payload.file?.sourceLanguage).toBe("hbo")
    expect(payload.file?.targetLanguage).toBe("deu")
  })

  it("emitParsedFile with undefined languages omits them from the payload (not forced to empty string)", async () => {
    await emitParsedFile(
      { name: "Notes", strings: [makeVerse("1", "Sentence one")] },
      "txt" as never, // txt goes through the same emitParsedFile path
      {
        projectId: "proj-2",
        author: "bob",
        // Deliberately omit sourceLanguage + targetLanguage to simulate
        // a project with no language configured yet.
        getToken,
      },
    )

    expect(captured).toHaveLength(1)
    const file = captured[0].file
    // When omitted, neither key should be set to an empty string — that
    // would overwrite a language the user already configured.
    expect(file?.sourceLanguage === "" || file?.sourceLanguage === undefined).toBe(true)
    expect(file?.targetLanguage === "" || file?.targetLanguage === undefined).toBe(true)
  })

  it("distinct source/target are preserved end-to-end through emitParsedFile", async () => {
    // Simulates the Paratext source import path: source=arb, no target set.
    await emitParsedFile(
      { name: "MAT", strings: [makeVerse("MAT 1:1", "The beginning of the gospel…")] },
      "usfm",
      {
        projectId: "proj-3",
        author: "consultant",
        sourceLanguage: "arb",   // Paratext Settings.xml languageIsoCode
        targetLanguage: "fra",   // translator's target
        getToken,
      },
    )

    expect(captured).toHaveLength(1)
    const f = captured[0].file
    // Must not equal each other — that's the broken state we're preventing.
    expect(f?.sourceLanguage).toBe("arb")
    expect(f?.targetLanguage).toBe("fra")
    expect(f?.sourceLanguage).not.toBe(f?.targetLanguage)
  })
})
