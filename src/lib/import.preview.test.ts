/**
 * AQU-310: tests for the split parse→preview→commit flow.
 *
 * Verifies that:
 * 1. parseFile() returns ImportResult[] without touching the network.
 * 2. The results contain the expected cells for various text formats.
 * 3. emitParsedFile() (the commit step) does call the bulk-upload endpoint.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { parseFile, emitParsedFile } from "./import"

// ─── fetch mock ─────────────────────────────────────────────────────────────
interface CapturedBody {
  projectId: string
  fileId: string
  cells: Array<{ id: string; cellId: string; anchorCellId: string | null; value: string }>
}
let captured: CapturedBody[]

beforeEach(() => {
  captured = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as CapturedBody
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

function makeFile(name: string, content: string): File {
  return new File([content], name, { type: "text/plain" })
}

// ─── parse phase: no network ─────────────────────────────────────────────────

describe("parseFile — parse phase only (no upload)", () => {
  it("parses a plain text file into cells without touching fetch", async () => {
    const file = makeFile("sample.txt", "Hello world\n\nSecond paragraph\n")
    const results = await parseFile(file, "txt")
    expect(results).toHaveLength(1)
    expect(results[0].name).toBe("sample.txt")
    expect(results[0].strings.length).toBeGreaterThan(0)
    expect(results[0].strings[0].original).toMatch(/Hello world/)
    // No network call during parse.
    expect(captured).toHaveLength(0)
  })

  it("parses a VTT subtitle file into cue cells without touching fetch", async () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:03.000",
      "First cue text",
      "",
      "00:00:04.000 --> 00:00:06.000",
      "Second cue text",
    ].join("\n")
    const file = makeFile("subs.vtt", vtt)
    const results = await parseFile(file, "vtt")
    expect(results).toHaveLength(1)
    expect(results[0].strings).toHaveLength(2)
    expect(results[0].strings[0].original).toBe("First cue text")
    expect(results[0].strings[0].type).toBe("cue")
    expect(captured).toHaveLength(0)
  })

  it("parses a markdown file into cells without touching fetch", async () => {
    const md = "# Title\n\nParagraph one.\n\nParagraph two.\n"
    const file = makeFile("doc.md", md)
    const results = await parseFile(file, "md")
    expect(results).toHaveLength(1)
    expect(results[0].strings.length).toBeGreaterThanOrEqual(2)
    expect(captured).toHaveLength(0)
  })

  it("throws for media file type — caller must use emitMediaFile()", async () => {
    const file = makeFile("clip.mp3", "binary")
    await expect(parseFile(file, "audio")).rejects.toThrow(/media files/)
  })

  it("throws for ebible file type — caller must use importEBible()", async () => {
    const file = makeFile("corpus.txt", "text")
    await expect(parseFile(file, "ebible")).rejects.toThrow(/eBible/)
  })
})

// ─── commit phase: emitParsedFile calls the network ──────────────────────────

describe("emitParsedFile — commit phase calls bulk upload", () => {
  it("uploads cells after parse and returns a FileReference", async () => {
    const strings = [
      { id: "a", original: "Hello", translated: "", context: "ctx", group: "g", type: "text" as const },
      { id: "b", original: "World", translated: "", context: "ctx", group: "g", type: "text" as const },
    ]
    const result = await emitParsedFile(
      { name: "test.txt", strings },
      "txt",
      {
        projectId: "proj-1",
        author: "tester",
        sourceLanguage: "en",
        targetLanguage: "fr",
        getToken: async () => "tok",
      },
    )
    // Upload was called.
    expect(captured.length).toBeGreaterThan(0)
    // FileReference has the expected shape.
    expect(result.ref.name).toBe("test.txt")
    expect(result.ref.cellCount).toBe(2)
  })
})

// ─── parse result shape ───────────────────────────────────────────────────────

describe("parseFile — result shape", () => {
  it("ImportResult has name + strings array", async () => {
    const file = makeFile("notes.txt", "Line one\nLine two\n")
    const [r] = await parseFile(file, "txt")
    expect(r).toHaveProperty("name")
    expect(r).toHaveProperty("strings")
    expect(Array.isArray(r.strings)).toBe(true)
  })

  it("each cell has required TranslatableString fields", async () => {
    const file = makeFile("notes.txt", "Hello world\n")
    const [r] = await parseFile(file, "txt")
    for (const s of r.strings) {
      expect(s).toHaveProperty("id")
      expect(s).toHaveProperty("original")
      expect(s).toHaveProperty("type")
    }
  })
})
