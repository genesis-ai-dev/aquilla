import { describe, it, expect } from "vitest"
import { extractPropertiesStrings, exportProperties } from "./properties"
import type { CellData } from "@/hooks/useCells"

function cell(over: Partial<CellData>): CellData {
  return {
    id: "c", fileId: "f", original: "", translated: "", context: "", group: "",
    type: "text", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [], ...over,
  }
}

async function blobText(blob: Blob): Promise<string> {
  return await blob.text()
}

describe("extractPropertiesStrings", () => {
  it("parses key=value, key = value, and key:value separator styles", () => {
    const strings = extractPropertiesStrings("a=1\nb = two\nc:three\nd: four")
    expect(strings.map((s) => [s.group, s.original])).toEqual([
      ["a", "1"], ["b", "two"], ["c", "three"], ["d", "four"],
    ])
  })

  it("sets context = key, group = key, type text, and a uuid id per pair", () => {
    const [s] = extractPropertiesStrings("greeting=hello")
    expect(s.context).toBe("greeting")
    expect(s.group).toBe("greeting")
    expect(s.type).toBe("text")
    expect(s.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(s.translated).toBe("")
  })

  it("skips comments (# and !) and blank lines", () => {
    const strings = extractPropertiesStrings("# comment\n! also a comment\n\n  \na=1\n   # indented comment\nb=2")
    expect(strings.map((s) => s.group)).toEqual(["a", "b"])
  })

  it("skips pairs with empty values", () => {
    const strings = extractPropertiesStrings("empty=\nalso.empty =   \nkept=x")
    expect(strings.map((s) => s.group)).toEqual(["kept"])
  })

  it("handles escaped separators in keys (\\= and \\:)", () => {
    const strings = extractPropertiesStrings("a\\=b=value1\nc\\:d:value2")
    expect(strings.map((s) => [s.group, s.original])).toEqual([
      ["a=b", "value1"], ["c:d", "value2"],
    ])
  })

  it("decodes \\uXXXX unicode escapes and standard escapes in values", () => {
    const strings = extractPropertiesStrings("cafe=caf\\u00e9\nmulti=line1\\nline2\ntab=a\\tb")
    expect(strings[0].original).toBe("café")
    expect(strings[1].original).toBe("line1\nline2")
    expect(strings[2].original).toBe("a\tb")
  })

  it("joins line continuations (trailing backslash), stripping the next line's leading whitespace", () => {
    const strings = extractPropertiesStrings("msg=hello \\\n    world\nnext=n")
    expect(strings.map((s) => [s.group, s.original])).toEqual([
      ["msg", "hello world"], ["next", "n"],
    ])
  })

  it("does not treat an escaped trailing backslash (\\\\) as a continuation", () => {
    const strings = extractPropertiesStrings("path=C:\\\\dir\\\\\nnext=n")
    expect(strings.map((s) => [s.group, s.original])).toEqual([
      ["path", "C:\\dir\\"], ["next", "n"],
    ])
  })
})

describe("exportProperties", () => {
  const source = [
    "# Header comment",
    "",
    "greeting=Hello",
    "farewell = Goodbye",
    "question:Why?",
    "! trailer comment",
  ].join("\n")

  it("substitutes translated values matched by group, preserving comments, blank lines, order, and separator style", async () => {
    const cells = [
      cell({ group: "farewell", translated: "Au revoir" }),
      cell({ group: "greeting", translated: "Bonjour" }),
      cell({ group: "question", translated: "Pourquoi?" }),
    ]
    const blob = exportProperties(source, cells)
    expect(blob.type).toBe("text/plain;charset=utf-8")
    expect(await blobText(blob)).toBe([
      "# Header comment",
      "",
      "greeting=Bonjour",
      "farewell = Au revoir",
      "question:Pourquoi?",
      "! trailer comment",
    ].join("\n"))
  })

  it("falls back to positional order when no group matches, and to the original value when untranslated", async () => {
    const cells = [
      cell({ group: "nope-1", translated: "Salut" }),   // positional → greeting
      cell({ group: "nope-2", translated: "" }),        // positional, empty → keep original
      cell({ group: "nope-3", translated: "Hein?" }),   // positional → question
    ]
    const text = await blobText(exportProperties(source, cells))
    expect(text).toContain("greeting=Salut")
    expect(text).toContain("farewell = Goodbye")
    expect(text).toContain("question:Hein?")
  })

  it("escapes backslashes and control chars, leaving non-Latin-1 as UTF-8", async () => {
    const cells = [cell({ group: "k", translated: "C:\\dir\nnext\tstop — héllo 世界" })]
    const text = await blobText(exportProperties("k=v", cells))
    expect(text).toBe("k=C:\\\\dir\\nnext\\tstop — héllo 世界")
  })

  it("preserves keys with escaped separators and matches them by decoded key", async () => {
    const cells = [cell({ group: "a=b", translated: "translated" })]
    const text = await blobText(exportProperties("a\\=b=original", cells))
    expect(text).toBe("a\\=b=translated")
  })

  it("round-trips: extract(export(...)) yields translated values under the same keys", async () => {
    const extracted = extractPropertiesStrings(source)
    const translations: Record<string, string> = {
      greeting: "Hola", farewell: "Adiós", question: "¿Por qué?\ndime",
    }
    const cells = extracted.map((s) => cell({ group: s.group, translated: translations[s.group] }))
    const text = await blobText(exportProperties(source, cells))
    const reExtracted = extractPropertiesStrings(text)
    expect(Object.fromEntries(reExtracted.map((s) => [s.group, s.original]))).toEqual(translations)
  })
})
