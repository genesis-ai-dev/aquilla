import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { parseDocumentFile } from "./parse-document"
import { buildPdf } from "@/lib/parsers/__fixtures__/build-pdf"

const JWT = "jwt"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("parseDocumentFile", () => {
  it("returns the extracted text on success", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ text: "Thou shalt not kill." }))
    await expect(parseDocumentFile(new File(["x"], "r.docx"), JWT)).resolves.toBe(
      "Thou shalt not kill.",
    )
  })

  // AQU-820: RuleImportDialog renders `err.message` verbatim. The worker's 422
  // interpolates the raw extractor exception into its `error` string, so a
  // passthrough would put a stack-shaped diagnostic in front of the user — in
  // English, whatever locale they chose.
  it("throws our keyed message, never the server's error text", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "Could not extract text: TypeError: bad xref table" }, 422),
    )
    const err = await parseDocumentFile(new File(["x"], "r.docx"), JWT).catch((e: unknown) => e)
    expect((err as Error).message).toBe(
      "We couldn't read that file. It may be image-only, encrypted, or not a valid PDF or DOCX.",
    )
    expect((err as Error).message).not.toContain("TypeError")
  })

  it("keeps the server's error text on .cause for DevTools", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "bad xref table" }, 422))
    const err = await parseDocumentFile(new File(["x"], "r.docx"), JWT).catch((e: unknown) => e)
    expect(String((err as Error).cause)).toContain("bad xref table")
    expect(String((err as Error).cause)).toContain("422")
  })

  // AQU-2551 review findings 1–3: the server no longer parses PDFs (a 2 MB
  // upload could make it decode a gigabyte). A PDF is read here, in the
  // browser, with the import's own reader, and never sent.
  it("reads a PDF in the browser and never sends it to the server", async () => {
    const pdf = buildPdf({ pages: [{ runs: [
      { text: "Always write the divine name in small capitals.", x: 72, y: 700 },
      { text: "Keep it so in every book.", x: 72, y: 686 },
      { text: "Never translate proper names.", x: 72, y: 650 },
    ] }] })
    const text = await parseDocumentFile(new File([pdf], "rules.pdf", { type: "application/pdf" }), JWT)
    expect(text).toBe("Always write the divine name in small capitals. Keep it so in every book.\nNever translate proper names.")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("says why a PDF it reads in the browser has no text, in the import's words", async () => {
    const scanned = buildPdf({ pages: [{ image: true }] })
    await expect(parseDocumentFile(new File([scanned], "scan.pdf"), JWT)).rejects.toThrow(
      "This PDF is a scanned image. It has no text to import.",
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("turns the server's refusal of a PDF into one plain sentence", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "PDFs are read in the app.", code: "pdf-text-required" }, 415))
    await expect(parseDocumentFile(new File(["x"], "r.docx"), JWT)).rejects.toThrow(
      "Reload the page, then add this PDF again.",
    )
  })

  // A 200 with no `text` is the same dead end for the user as a 4xx, and used
  // to throw the untranslated "Worker returned empty text."
  it("treats an ok response with no text as the same keyed failure", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    await expect(parseDocumentFile(new File(["x"], "r.docx"), JWT)).rejects.toThrow(
      "We couldn't read that file.",
    )
  })
})
