/**
 * AQU-310: tests for the split parse→preview→commit flow.
 *
 * Verifies that:
 * 1. parseFile() returns ImportResult[] without touching the network.
 * 2. The results contain the expected cells for various text formats.
 * 3. emitParsedFile() (the commit step) does call the bulk-upload endpoint.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { parseFile, prepareImportFile, emitParsedFile } from "./import"

// ─── fetch mock ─────────────────────────────────────────────────────────────
interface CapturedBody {
  projectId: string
  fileId: string
  file?: { kind?: string; fileType?: string }
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
    expect(results[0].rawSourceFormat).toBe("txt")
    expect(new TextDecoder().decode(results[0].rawBytes!)).toBe("Hello world\n\nSecond paragraph\n")
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
    expect(results[0].rawSourceFormat).toBe("vtt")
    expect(results[0].rawBytes).toBeInstanceOf(ArrayBuffer)
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

  it("preserves exact USX bytes and labels the original format honestly", async () => {
    const usx = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<usx version="3.0">',
      '<book code="GEN" style="id">Genesis</book>',
      '<chapter number="1" style="c" sid="GEN 1" />',
      '<para style="s1">Creation</para>',
      '<para style="p"><verse number="1" style="v" sid="GEN 1:1" />In the beginning.</para>',
      '</usx>',
    ].join("\n")

    const [result] = await parseFile(makeFile("Genesis.usx", usx), "usfm")

    expect(result.rawSourceFormat).toBe("usx")
    expect(new TextDecoder().decode(result.rawBytes!)).toBe(usx)
    expect(result.strings.map((cell) => cell.type)).toEqual(["heading", "verse"])
    expect(result.strings.find((cell) => cell.type === "verse")?.globalReferences).toEqual(["GEN 1:1"])
    expect(captured).toHaveLength(0)
  })

  it("sniffs Scripture content before trusting a generic .txt extension", async () => {
    const file = makeFile("misnamed.txt", "\\id GEN\n\\c 1\n\\v 1 In the beginning.\n")
    const prepared = await prepareImportFile(file, { projectId: "p1" })
    expect(prepared.fileType).toBe("usfm")
    expect(prepared.results[0].strings[0].type).toBe("verse")
  })

  it("strictly decodes UTF-16 known text instead of importing NUL-corrupted content", async () => {
    const value = "First paragraph\n\nSecond paragraph"
    const payload = new Uint8Array(2 + value.length * 2)
    payload[0] = 0xff
    payload[1] = 0xfe
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)
      payload[2 + index * 2] = code & 0xff
      payload[3 + index * 2] = code >> 8
    }
    const [result] = await parseFile(new File([payload], "utf16.txt"), "txt")
    expect(result.strings.map((cell) => cell.original).join(" ")).toContain("First paragraph")
    expect(result.strings.map((cell) => cell.original).join(" ")).toContain("Second paragraph")
    expect(result.strings.some((cell) => cell.original.includes("\0"))).toBe(false)
  })

  it("rejects legacy OLE .doc explicitly instead of misrouting it through DOCX", async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])
    await expect(prepareImportFile(new File([ole], "legacy.doc"), { projectId: "p1" }))
      .rejects.toThrow(/appears to be binary/)
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

  it("stores TMX as translation-memory while retaining the TMX parser type", async () => {
    await emitParsedFile(
      {
        name: "memory.tmx",
        strings: [{ id: "tu-1", original: "Hello", translated: "", context: "tu-1", group: "tu-1", type: "text" }],
      },
      "tmx",
      {
        projectId: "proj-1",
        author: "tester",
        sourceLanguage: "en",
        targetLanguage: "fr",
        getToken: async () => "tok",
      },
    )
    expect(captured[0].file).toMatchObject({ fileType: "tmx", kind: "translation-memory" })
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
