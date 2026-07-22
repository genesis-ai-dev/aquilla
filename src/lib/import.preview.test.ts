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

const PASS_PROGRAM_DIGEST = "d74ff0ee8da3b9806b18c877dbf29bbde50b5bd8e4dad7a3a725000feb82e8f1"

// ─── fetch mock ─────────────────────────────────────────────────────────────
interface CapturedBody {
  projectId: string
  fileId: string
  file?: { kind?: string; fileType?: string; importManifest?: { hasScriptureContent?: boolean } }
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

  it("gives every book in a concatenated USFM its own export skeleton and retains the exact bundle once", async () => {
    const bundle = "\\id GEN\n\\c 1\n\\v 1 In the beginning.\n\\id EXO\n\\c 1\n\\v 1 These are the names.\n"

    const results = await parseFile(makeFile("bundle.usfm", bundle), "usfm")

    expect(results).toHaveLength(2)
    expect(results[0].rawSource).toContain("\\id GEN")
    expect(results[0].rawSource).not.toContain("\\id EXO")
    expect(results[1].rawSource).toContain("\\id EXO")
    expect(results.every((result) => result.rawBytes === undefined)).toBe(true)
    expect(results.every((result) => result.rawSourceFormat === "usfm")).toBe(true)
    expect(new TextDecoder().decode(results[0].sharedSourceArtifact?.bytes)).toBe(bundle)
    expect(results[1].sharedSourceArtifact).toBeUndefined()
  })

  it("sniffs Scripture content before trusting a generic .txt extension", async () => {
    const file = makeFile("misnamed.txt", "\\id GEN\n\\c 1\n\\v 1 In the beginning.\n")
    const prepared = await prepareImportFile(file, { projectId: "p1" })
    expect(prepared.fileType).toBe("usfm")
    expect(prepared.results[0].strings[0].type).toBe("verse")
  })

  it("uses AI structural review for a recognized text container with record-shaped content", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      classification: {
        category: "subtitles",
        confidence: 0.93,
        explanation: "Pipe-delimited speaker cues",
        recipe: {
          name: "Speaker cues",
          inputFormat: "pipe-records",
          config: {
            recordMode: "delimited",
            delimiter: "pipe",
            hasHeader: true,
            sourceField: "text",
            speakerField: "speaker",
          },
        },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } }))
    vi.stubGlobal("fetch", fetchMock)

    const prepared = await prepareImportFile(
      makeFile("episode.txt", "speaker|text\nAlice|Hello\nBob|Goodbye"),
      { projectId: "p1", identityToken: "identity-token" },
    )

    expect(prepared.fileType).toBe("custom")
    expect(prepared.results[0].strings.map((cell) => [cell.original, cell.speaker, cell.type])).toEqual([
      ["Hello", "Alice", "cue"],
      ["Goodbye", "Bob", "cue"],
    ])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it("falls back visibly to the built-in parser when structural review is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("temporarily unavailable", { status: 503 })))

    const prepared = await prepareImportFile(
      makeFile("episode.txt", "speaker|text\nAlice|Hello\nBob|Goodbye"),
      { projectId: "p1", identityToken: "identity-token" },
    )

    expect(prepared.fileType).toBe("txt")
    expect(prepared.results[0].importNotices).toEqual([
      expect.objectContaining({ code: "basic-parser-fallback", severity: "warning" }),
    ])
    expect(prepared.results[0].strings.length).toBeGreaterThan(0)
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

  it("escalates an unsupported binary to the isolated parser and keeps the exact original for commit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      classification: {
        category: "document",
        confidence: 0.9,
        explanation: "Legacy document records",
        recipe: {
          version: 1,
          id: `sandbox-${PASS_PROGRAM_DIGEST.slice(0, 32)}`,
          name: "Legacy document parser",
          inputFormat: "legacy-doc",
          strategy: "sandbox-program",
          config: { outputSchema: "aquilla-import-units-v1", programSha256: PASS_PROGRAM_DIGEST },
          proposedBy: "ai",
          program: { language: "python", source: "pass", sha256: PASS_PROGRAM_DIGEST },
        },
      },
      units: [{ sourceText: "Legacy heading", type: "heading" }, { sourceText: "Legacy body", type: "text" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })))
    const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

    const prepared = await prepareImportFile(new File([bytes], "legacy.odd"), {
      projectId: "p1",
      identityToken: "identity-token",
    })

    expect(prepared.fileType).toBe("custom")
    expect(prepared.results[0].strings.map((cell) => [cell.original, cell.type])).toEqual([
      ["Legacy heading", "heading"],
      ["Legacy body", "text"],
    ])
    expect(new Uint8Array(prepared.results[0].rawBytes!)).toEqual(bytes)
    expect(prepared.results[0].importRecipe).toMatchObject({ strategy: "sandbox-program" })
  })

  it("escalates when a recognized adapter yields no importable cells", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      classification: {
        category: "document",
        confidence: 0.84,
        explanation: "Content is stored outside ordinary HTML body blocks.",
        recipe: {
          version: 1,
          id: `sandbox-${PASS_PROGRAM_DIGEST.slice(0, 32)}`,
          name: "Embedded HTML record parser",
          inputFormat: "legacy-html",
          strategy: "sandbox-program",
          config: { outputSchema: "aquilla-import-units-v1", programSha256: PASS_PROGRAM_DIGEST },
          proposedBy: "ai",
          program: { language: "python", source: "pass", sha256: PASS_PROGRAM_DIGEST },
        },
      },
      units: [{ sourceText: "Recovered embedded text", type: "text" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })))

    const prepared = await prepareImportFile(
      makeFile("empty.html", "<!doctype html><html><body></body></html>"),
      { projectId: "p1", identityToken: "identity-token" },
    )

    expect(prepared.fileType).toBe("custom")
    expect(prepared.results[0].strings[0].original).toBe("Recovered embedded text")
  })

  it("uses the deterministic HTML adapter and preserves structural headings", async () => {
    const prepared = await prepareImportFile(
      makeFile("page.html", "<!doctype html><html><body><h1>Title</h1><p>Body</p></body></html>"),
      { projectId: "p1" },
    )
    expect(prepared.fileType).toBe("html")
    expect(prepared.results[0].strings.map((value) => [value.original, value.type])).toEqual([
      ["Title", "heading"],
      ["Body", "text"],
    ])
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

  it("marks format-neutral imports with canonical Scripture content", async () => {
    const result = await emitParsedFile(
      {
        name: "mapped.csv",
        strings: [{
          id: "GEN 1:1",
          original: "In the beginning",
          translated: "",
          context: "GEN 1:1",
          group: "GEN 1",
          section: "GEN 1",
          globalReferences: ["GEN 1:1"],
          type: "verse",
        }],
      },
      "csv",
      {
        projectId: "proj-1",
        author: "tester",
        sourceLanguage: "en",
        targetLanguage: "fr",
        getToken: async () => "tok",
      },
    )

    expect(result.ref).toMatchObject({ type: "csv", hasScriptureContent: true })
    expect(captured[0]?.file?.importManifest).toMatchObject({ hasScriptureContent: true })
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
