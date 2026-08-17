import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { parseDocumentFile } from "./parse-document"

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
    await expect(parseDocumentFile(new File(["x"], "r.pdf"), JWT)).resolves.toBe(
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
    const err = await parseDocumentFile(new File(["x"], "r.pdf"), JWT).catch((e: unknown) => e)
    expect((err as Error).message).toBe(
      "We couldn't read that file. It may be image-only, encrypted, or not a valid PDF or DOCX.",
    )
    expect((err as Error).message).not.toContain("TypeError")
  })

  it("keeps the server's error text on .cause for DevTools", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "bad xref table" }, 422))
    const err = await parseDocumentFile(new File(["x"], "r.pdf"), JWT).catch((e: unknown) => e)
    expect(String((err as Error).cause)).toContain("bad xref table")
    expect(String((err as Error).cause)).toContain("422")
  })

  // A 200 with no `text` is the same dead end for the user as a 4xx, and used
  // to throw the untranslated "Worker returned empty text."
  it("treats an ok response with no text as the same keyed failure", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    await expect(parseDocumentFile(new File(["x"], "r.pdf"), JWT)).rejects.toThrow(
      "We couldn't read that file.",
    )
  })
})
