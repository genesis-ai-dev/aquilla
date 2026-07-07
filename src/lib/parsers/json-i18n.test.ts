import { describe, it, expect } from "vitest"
import { extractJsonStrings, exportJson } from "./json-i18n"
import type { CellData } from "@/hooks/useCells"

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeCell(original: string, translated: string): CellData {
  return {
    id: `cell-${original}`,
    fileId: "test-file",
    original,
    translated,
    context: "",
    group: "",
    type: "text",
    status: translated ? "unvalidated" : "empty",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
  }
}

/** Build the positional cell list for a document from extract order. */
function cellsFor(content: string, translate: (original: string) => string): CellData[] {
  return extractJsonStrings(content).map((s) => makeCell(s.original, translate(s.original)))
}

async function blobText(blob: Blob): Promise<string> {
  return blob.text()
}

// ─── extractJsonStrings ──────────────────────────────────────────────────────

describe("extractJsonStrings", () => {
  it("walks nested objects depth-first in key order with dot paths", () => {
    const content = JSON.stringify({
      app: { title: "My App", menu: { file: "File", edit: "Edit" } },
      footer: "Copyright",
    })
    const strings = extractJsonStrings(content)
    expect(strings.map((s) => ({ path: s.context, original: s.original }))).toEqual([
      { path: "app.title", original: "My App" },
      { path: "app.menu.file", original: "File" },
      { path: "app.menu.edit", original: "Edit" },
      { path: "footer", original: "Copyright" },
    ])
    for (const s of strings) {
      expect(s.group).toBe(s.context)
      expect(s.type).toBe("text")
      expect(s.translated).toBe("")
      expect(s.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }
    expect(new Set(strings.map((s) => s.id)).size).toBe(strings.length)
  })

  it("indexes arrays with [i] notation, including nested containers", () => {
    const content = JSON.stringify({
      messages: ["Hello", "World"],
      items: [{ label: "First" }, ["Deep"]],
    })
    const strings = extractJsonStrings(content)
    expect(strings.map((s) => s.context)).toEqual([
      "messages[0]",
      "messages[1]",
      "items[0].label",
      "items[1][0]",
    ])
  })

  it("uses bracket + JSON.stringify notation for non-identifier keys", () => {
    const content = JSON.stringify({
      'weird "key"': "quoted",
      "has space": "spaced",
      nested: { "dash-key": "dashed" },
      ok_$1: "plain",
    })
    const strings = extractJsonStrings(content)
    expect(strings.map((s) => s.context)).toEqual([
      '["weird \\"key\\""]',
      '["has space"]',
      'nested["dash-key"]',
      "ok_$1",
    ])
  })

  it("skips non-string leaves and empty strings", () => {
    const content = JSON.stringify({
      count: 42,
      enabled: true,
      missing: null,
      blank: "",
      list: ["", 3, false, "kept"],
      text: "hello",
    })
    const strings = extractJsonStrings(content)
    expect(strings.map((s) => ({ path: s.context, original: s.original }))).toEqual([
      { path: "list[3]", original: "kept" },
      { path: "text", original: "hello" },
    ])
  })

  it("throws a descriptive error on invalid JSON", () => {
    expect(() => extractJsonStrings("{ not json")).toThrow(/Invalid JSON/)
  })
})

// ─── exportJson ──────────────────────────────────────────────────────────────

describe("exportJson", () => {
  it("replaces string leaves positionally and leaves non-strings untouched", async () => {
    const original = JSON.stringify(
      { title: "Hello", count: 7, flags: [true, null], nested: { msg: "World", pi: 3.14 } },
      null,
      2,
    )
    const cells = [makeCell("Hello", "Bonjour"), makeCell("World", "Monde")]
    const out = JSON.parse(await blobText(exportJson(original, cells)))
    expect(out).toEqual({
      title: "Bonjour",
      count: 7,
      flags: [true, null],
      nested: { msg: "Monde", pi: 3.14 },
    })
  })

  it("falls back to cell.original when translated is empty, and keeps leaves beyond the cell list unchanged", async () => {
    const original = JSON.stringify({ a: "one", b: "two", c: "three" })
    // b has no translation → falls back to its original; c has no cell at all.
    const cells = [makeCell("one", "uno"), makeCell("two", "")]
    const out = JSON.parse(await blobText(exportJson(original, cells)))
    expect(out).toEqual({ a: "uno", b: "two", c: "three" })
  })

  it("skips empty-string values in the walk so alignment matches extraction", async () => {
    const original = JSON.stringify({ blank: "", a: "one", b: "two" })
    const cells = cellsFor(original, (o) => o.toUpperCase())
    const out = JSON.parse(await blobText(exportJson(original, cells)))
    expect(out).toEqual({ blank: "", a: "ONE", b: "TWO" })
  })

  it("preserves 2-space indentation with a trailing newline", async () => {
    const original = JSON.stringify({ a: { b: "x" } }, null, 2)
    const text = await blobText(exportJson(original, [makeCell("x", "y")]))
    expect(text).toBe('{\n  "a": {\n    "b": "y"\n  }\n}\n')
  })

  it("preserves 4-space indentation", async () => {
    const original = JSON.stringify({ a: { b: "x" } }, null, 4)
    const text = await blobText(exportJson(original, [makeCell("x", "y")]))
    expect(text).toBe('{\n    "a": {\n        "b": "y"\n    }\n}\n')
  })

  it("preserves tab indentation", async () => {
    const original = JSON.stringify({ a: "x" }, null, "\t")
    const text = await blobText(exportJson(original, [makeCell("x", "y")]))
    expect(text).toBe('{\n\t"a": "y"\n}\n')
  })

  it("returns a JSON blob with the right MIME type", () => {
    const blob = exportJson("{}", [])
    expect(blob.type).toBe("application/json;charset=utf-8")
  })

  it("throws on invalid original JSON", () => {
    expect(() => exportJson("nope{", [])).toThrow(/Invalid JSON/)
  })
})

// ─── round-trip ──────────────────────────────────────────────────────────────

describe("round-trip", () => {
  it("extract(export(...)) yields translated values at the same paths", async () => {
    const original = JSON.stringify(
      {
        app: { title: "Title", "has space": "Spaced" },
        messages: ["First", "", "Third"],
        n: 1,
        ok: false,
      },
      null,
      2,
    )
    const before = extractJsonStrings(original)
    const cells = before.map((s) => makeCell(s.original, `«${s.original}»`))
    const exported = await blobText(exportJson(original, cells))
    const after = extractJsonStrings(exported)

    expect(after.map((s) => s.context)).toEqual(before.map((s) => s.context))
    expect(after.map((s) => s.original)).toEqual(before.map((s) => `«${s.original}»`))
    // Structure and non-string values survive byte-for-byte semantically.
    const reparsed = JSON.parse(exported)
    expect(reparsed.n).toBe(1)
    expect(reparsed.ok).toBe(false)
    expect(reparsed.messages[1]).toBe("")
  })
})
