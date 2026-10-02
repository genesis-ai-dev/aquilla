import { afterEach, describe, expect, it, vi } from "vitest"

import {
  getKnowledgeDocumentContent,
  isKnowledgeIndexStalled,
  KB_INDEX_STALE_MS,
  KnowledgeBaseApiError,
  listKnowledgeDocuments,
  uploadKnowledgeDocument,
} from "./knowledge-base"

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
      .resolves.toEqual(doc)

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toMatch(/\/api\/v2\/orgs\/42\/knowledge$/)
    expect(init.method).toBe("POST")
    expect(init.body).toBe(file)
    expect(new Headers(init.headers).get("x-doc-name")).toBe("style%20guide.md")
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
