import { afterEach, describe, expect, it, vi } from "vitest"

import {
  getKnowledgeDocumentContent,
  isKnowledgeIndexStalled,
  KB_INDEX_STALE_MS,
  KnowledgeBaseApiError,
  KnowledgeBaseReadError,
  listKnowledgeDocuments,
  uploadKnowledgeDocument,
} from "./knowledge-base"
import { buildPdf } from "@/lib/parsers/__fixtures__/build-pdf"
import { readPdfText } from "@/lib/import/pdf-import"
import { MAX_KB_TEXT_CHARS } from "../../../db/shared/knowledge"

vi.mock("@/lib/import/pdf-import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/import/pdf-import")>()
  return { ...actual, readPdfText: vi.fn(actual.readPdfText) }
})

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

afterEach(() => vi.unstubAllGlobals())

describe("Knowledge Base API client", () => {
  it("passes the authenticated project-list producer response to the client model", async () => {
    const docs = [{ id: "doc-1", name: "guide.md", scope: "project" }]
    const fetchSpy = vi.fn().mockResolvedValue(response({ docs }))
    vi.stubGlobal("fetch", fetchSpy)

    await expect(listKnowledgeDocuments({ kind: "project", id: "project/a" }, "jwt-1"))
      .resolves.toEqual(docs)

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/api\/v2\/projects\/project%2Fa\/knowledge$/)
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer jwt-1")
  })

  it("uploads original bytes with the encoded document-name contract", async () => {
    const doc = { id: "doc-2", name: "style guide.md", scope: "org" }
    const fetchSpy = vi.fn().mockResolvedValue(response({ doc }, 201))
    vi.stubGlobal("fetch", fetchSpy)
    const file = new File(["Use formal language."], "style guide.md", { type: "text/markdown" })

    await expect(uploadKnowledgeDocument({ kind: "org", id: 42 }, "jwt-2", file))
      .resolves.toEqual({ doc, textTruncated: false })

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/api\/v2\/orgs\/42\/knowledge$/)
    expect(init.method).toBe("POST")
    expect(init.body).toBe(file)
    expect(new Headers(init.headers).get("x-doc-name")).toBe("style%20guide.md")
  })

  // AQU-2551 review findings 1–3: the server no longer parses PDFs. A PDF is
  // read here with the import's reader, and the upload carries the untouched
  // original and its text.
  it("reads a PDF in the browser and uploads the original with its text", async () => {
    const doc = { id: "doc-3", name: "guide.pdf", scope: "project" }
    const fetchSpy = vi.fn().mockResolvedValue(response({ doc }, 201))
    vi.stubGlobal("fetch", fetchSpy)
    const pdf = buildPdf({ pages: [{ runs: [{ text: "Use formal language.", x: 72, y: 700 }] }] })
    const file = new File([pdf], "guide.pdf", { type: "application/pdf" })

    await expect(uploadKnowledgeDocument({ kind: "project", id: "p-1" }, "jwt", file)).resolves.toEqual({ doc, textTruncated: false })

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(init.body).toBeInstanceOf(FormData)
    const form = init.body as FormData
    expect(form.get("text")).toBe("Use formal language.")
    const sent = form.get("file") as File
    expect(new Uint8Array(await sent.arrayBuffer())).toEqual(new Uint8Array(pdf))
    expect(new Headers(init.headers).get("x-doc-name")).toBe("guide.pdf")
  })

  // A huge PDF's text is cut in the browser, one past the server's cap, so
  // the form stays under its byte limit and the server still marks the
  // document truncated instead of refusing it as too large.
  it("sends only one character past the text cap for a huge PDF", async () => {
    const doc = { id: "doc-5", name: "huge.pdf", scope: "project" }
    const fetchSpy = vi.fn().mockResolvedValue(response({ doc, textTruncated: true }, 201))
    vi.stubGlobal("fetch", fetchSpy)
    vi.mocked(readPdfText).mockResolvedValueOnce("a".repeat(MAX_KB_TEXT_CHARS + 5_000))
    const file = new File([buildPdf({ pages: [{ runs: [{ text: "x", x: 72, y: 700 }] }] })], "huge.pdf")

    await expect(uploadKnowledgeDocument({ kind: "project", id: "p-1" }, "jwt", file))
      .resolves.toEqual({ doc, textTruncated: true })

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(((init.body as FormData).get("text") as string).length).toBe(MAX_KB_TEXT_CHARS + 1)
  })

  it("refuses a PDF it cannot read before uploading, in the import's words", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const scanned = new File([buildPdf({ pages: [{ image: true }] })], "scan.pdf")
    const thrown = await uploadKnowledgeDocument({ kind: "project", id: "p-1" }, "jwt", scanned).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(KnowledgeBaseReadError)
    expect((thrown as Error).message).toBe("This PDF is a scanned image. It has no text to import.")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("turns the server's refusal of a PDF without its text into one plain sentence", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      response({ error: { code: "pdf_text_required", message: "PDFs are read in the app." } }, 415),
    ))
    const file = new File(["# notes"], "notes.md")
    const thrown = await uploadKnowledgeDocument({ kind: "project", id: "p-1" }, "jwt", file).catch((e: unknown) => e)
    expect((thrown as KnowledgeBaseApiError).serverMessage).toBe("Reload the page, then add this PDF again.")
  })

  it("passes on that only the first part of the text was kept (AQU-2594)", async () => {
    const doc = { id: "doc-4", name: "long.md", scope: "project" }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ doc, textTruncated: true }, 201)))
    const file = new File(["# long"], "long.md", { type: "text/markdown" })

    await expect(uploadKnowledgeDocument({ kind: "project", id: "p-1" }, "jwt", file))
      .resolves.toEqual({ doc, textTruncated: true })
  })

  // AQU-1499: the boundary used to keep only the status, so a rejection the
  // server had explained — a .docx whose word/document.xml is too bloated to
  // read — reached the UI as "Could not upload X. Try again." on a retry that
  // can never succeed.
  it("keeps the server's explanation on a rejected upload", async () => {
    const message =
      "could not extract text: the document is too complex to read: word/document.xml is 39.5 MB, " +
      'over the 64 MB limit. Re-saving the file from Word ("Save As" a new .docx) usually shrinks it.'
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ error: { code: "validation_failed", message } }, 422)),
    )
    const file = new File(["bytes"], "The Real God_Arabic (1).docx")

    const thrown = await uploadKnowledgeDocument({ kind: "project", id: "p-1" }, "jwt", file)
      .then(() => null, (err: unknown) => err)

    expect(thrown).toBeInstanceOf(KnowledgeBaseApiError)
    const err = thrown as KnowledgeBaseApiError
    expect(err.status).toBe(422)
    expect(err.serverMessage).toBe(message)
  })

  it("falls back to the status alone when the error body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>502</html>", { status: 502 })))
    const file = new File(["bytes"], "notes.md")

    const thrown = await uploadKnowledgeDocument({ kind: "project", id: "p-1" }, "jwt", file)
      .then(() => null, (err: unknown) => err)

    expect(thrown).toBeInstanceOf(KnowledgeBaseApiError)
    expect((thrown as KnowledgeBaseApiError).serverMessage).toBeUndefined()
    expect((thrown as KnowledgeBaseApiError).status).toBe(502)
  })

  it("addresses extracted content by document and node id", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(response({ text: "Selected section" }))
    vi.stubGlobal("fetch", fetchSpy)

    await expect(getKnowledgeDocumentContent(
      { kind: "project", id: "project-1" },
      "jwt-3",
      "doc/3",
      "n1.2",
    )).resolves.toBe("Selected section")

    expect(fetchSpy.mock.calls[0]?.[0]).toMatch(
      /\/knowledge\/doc%2F3\/content\?nodeId=n1\.2$/,
    )
  })
})

// AQU-1376: indexing is a fire-and-forget worker job with no cron behind it, so
// the read side is what has to notice a job that never came back.
describe("isKnowledgeIndexStalled", () => {
  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

  it("flags a pending doc whose job can no longer be running", () => {
    expect(isKnowledgeIndexStalled({
      indexStatus: "pending",
      updatedAt: at(KB_INDEX_STALE_MS + 1_000),
    })).toBe(true)
  })

  it("leaves a doc inside its normal processing window alone", () => {
    // The negative case that matters: a slow-but-live job must not be called a
    // failure, or a retry would cancel work that was about to land.
    expect(isKnowledgeIndexStalled({
      indexStatus: "pending",
      updatedAt: at(KB_INDEX_STALE_MS - 1_000),
    })).toBe(false)
  })

  it("never flags a terminal status, however old", () => {
    for (const indexStatus of ["ready", "failed"] as const) {
      expect(isKnowledgeIndexStalled({ indexStatus, updatedAt: at(KB_INDEX_STALE_MS * 100) }))
        .toBe(false)
    }
  })

  it("treats an unparseable timestamp as not-stalled rather than guessing", () => {
    expect(isKnowledgeIndexStalled({ indexStatus: "pending", updatedAt: "not a date" }))
      .toBe(false)
  })

  it("stays clear of the worker's own 60s enrichment ceiling", () => {
    // If this window ever slipped under the worker's fetch timeout, a job still
    // inside its budget would be shown as stalled.
    expect(KB_INDEX_STALE_MS).toBeGreaterThan(60_000)
  })
})
