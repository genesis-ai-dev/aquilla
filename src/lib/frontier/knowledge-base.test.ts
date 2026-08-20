import { afterEach, describe, expect, it, vi } from "vitest"

import {
  getKnowledgeDocumentContent,
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
