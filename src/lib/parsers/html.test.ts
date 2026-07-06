import { describe, expect, it } from "vitest"
import type { CellData } from "@/hooks/useCells"
import { exportHtml, extractHtmlStrings } from "./html"

function makeCell(overrides: Partial<CellData>): CellData {
  return {
    id: "cell-1",
    fileId: "file-1",
    original: "Hello world",
    translated: "Bonjour monde",
    context: "",
    group: "g-1",
    type: "text",
    status: "unvalidated",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    ...overrides,
  }
}

/** Turn extracted strings into cells carrying the given translations (by index). */
function cellsFor(strings: ReturnType<typeof extractHtmlStrings>, translations: string[]): CellData[] {
  return strings.map((s, i) =>
    makeCell({
      id: s.id,
      original: s.original,
      translated: translations[i] ?? "",
      context: s.context,
      group: s.group,
      type: s.type,
    }),
  )
}

async function blobText(blob: Blob): Promise<string> {
  return blob.text()
}

const DOC = `<!DOCTYPE html>
<html>
  <head>
    <title>My Page</title>
    <style>p { color: red; }</style>
    <script>console.log("never extract this")</script>
  </head>
  <body>
    <h1>Main Title</h1>
    <p>First <strong>paragraph</strong> here.</p>
    <h2>Section</h2>
    <ul>
      <li>Alpha item</li>
      <li>Beta item</li>
    </ul>
    <blockquote>A famous quote.</blockquote>
    <noscript>Enable JS</noscript>
  </body>
</html>`

describe("extractHtmlStrings", () => {
  it("extracts headings, paragraphs, and lists with correct types and contexts", () => {
    const strings = extractHtmlStrings(DOC)
    expect(strings.map((s) => [s.original, s.type, s.context])).toEqual([
      ["My Page", "heading", "Title"],
      ["Main Title", "heading", "Heading 1"],
      ["First paragraph here.", "text", "Paragraph"],
      ["Section", "heading", "Heading 2"],
      ["Alpha item", "list", "List item"],
      ["Beta item", "list", "List item"],
      ["A famous quote.", "blockquote", "Blockquote"],
    ])
    // Every string gets a unique id + group and an indexed sourceLocation.
    expect(new Set(strings.map((s) => s.id)).size).toBe(strings.length)
    expect(new Set(strings.map((s) => s.group)).size).toBe(strings.length)
    expect(strings.map((s) => s.sourceLocation)).toEqual(
      strings.map((_, i) => ({ file: "html", blockPath: String(i) })),
    )
  })

  it("captures originalHtml only for blocks with inline markup", () => {
    const strings = extractHtmlStrings(DOC)
    const para = strings.find((s) => s.context === "Paragraph")
    expect(para?.originalHtml).toContain("<strong>")
    const heading = strings.find((s) => s.original === "Main Title")
    expect(heading?.originalHtml).toBeUndefined()
  })

  it("skips script, style, and noscript content entirely", () => {
    const all = extractHtmlStrings(DOC).map((s) => s.original).join(" ")
    expect(all).not.toContain("color: red")
    expect(all).not.toContain("never extract this")
    expect(all).not.toContain("Enable JS")
  })

  it("does not double-extract nested blocks (outermost-leaf rule)", () => {
    const strings = extractHtmlStrings(
      "<body><ul><li><p>Nested para</p></li><li>Plain item</li></ul></body>",
    )
    expect(strings.map((s) => [s.original, s.type])).toEqual([
      ["Nested para", "text"],
      ["Plain item", "list"],
    ])
  })

  it("decodes entities in original", () => {
    const strings = extractHtmlStrings("<p>Fish &amp; chips &lt;3</p>")
    expect(strings).toHaveLength(1)
    expect(strings[0].original).toBe("Fish & chips <3")
  })

  it("skips whitespace-only blocks and collapses internal whitespace", () => {
    const strings = extractHtmlStrings("<p>  </p><p>two\n  lines</p>")
    expect(strings.map((s) => s.original)).toEqual(["two lines"])
  })
})

describe("exportHtml", () => {
  it("replaces text in place, preserving tag structure and doctype", async () => {
    const strings = extractHtmlStrings(DOC)
    const cells = cellsFor(strings, [
      "Ma Page",
      "Titre Principal",
      "Premier paragraphe ici.",
      "Rubrique",
      "Élément Alpha",
      "Élément Beta",
      "Une citation célèbre.",
    ])
    const html = await blobText(exportHtml(DOC, cells))

    expect(html.startsWith("<!DOCTYPE html>\n")).toBe(true)
    for (const tag of ["<h1>", "<h2>", "<ul>", "<li>", "<blockquote>", "<title>"]) {
      expect(html).toContain(tag)
    }
    expect(html).toContain("Titre Principal")
    expect(html).toContain("Élément Alpha")
    expect(html).toContain("Une citation célèbre.")
    expect(html).not.toContain("Main Title")
    expect(html).not.toContain("Alpha item")
    // Untouched skeleton parts survive.
    expect(html).toContain('console.log("never extract this")')
  })

  it("falls back to the source text for empty/whitespace translations", async () => {
    const src = "<body><p>Keep me</p><p>Translate me</p></body>"
    const strings = extractHtmlStrings(src)
    const cells = cellsFor(strings, ["   ", "Traduis-moi"])
    const html = await blobText(exportHtml(src, cells))
    expect(html).toContain("<p>Keep me</p>")
    expect(html).toContain("<p>Traduis-moi</p>")
  })

  it("leaves remaining blocks unchanged when cells run out", async () => {
    const src = "<body><p>One</p><p>Two</p></body>"
    const strings = extractHtmlStrings(src)
    const cells = cellsFor(strings, ["Un"]).slice(0, 1)
    const html = await blobText(exportHtml(src, cells))
    expect(html).toContain("<p>Un</p>")
    expect(html).toContain("<p>Two</p>")
  })

  it("omits the doctype prefix when the original had none", async () => {
    const html = await blobText(exportHtml("<body><p>Hi</p></body>", []))
    expect(html.toLowerCase().startsWith("<!doctype")).toBe(false)
  })

  it("sets the blob content type", () => {
    expect(exportHtml("<body><p>Hi</p></body>", []).type).toBe("text/html;charset=utf-8")
  })

  it("round-trips: extract(export(...)) yields same count and the translated texts", async () => {
    const strings = extractHtmlStrings(DOC)
    const translations = strings.map((s, i) => `T${i}: ${s.original}`)
    const html = await blobText(exportHtml(DOC, cellsFor(strings, translations)))
    const reExtracted = extractHtmlStrings(html)
    expect(reExtracted).toHaveLength(strings.length)
    expect(reExtracted.map((s) => s.original)).toEqual(translations)
    expect(reExtracted.map((s) => [s.type, s.context])).toEqual(
      strings.map((s) => [s.type, s.context]),
    )
  })
})
