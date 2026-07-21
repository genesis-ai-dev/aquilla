import { afterEach, describe, expect, it, vi } from "vitest"
import { importParatextAsTarget, type ParatextPlan } from "./import"

afterEach(() => vi.unstubAllGlobals())

describe("Paratext target import durability", () => {
  it("keeps the book staged until target USFM and the complete package are preserved", async () => {
    const calls: Array<{ url: string; init?: RequestInit; body?: Record<string, unknown> }> = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      calls.push({ url, init, body })
      if (url.includes("/source")) {
        return new Response(JSON.stringify({ artifactId: "a", key: "k", sha256: "f".repeat(64) }), { status: 200 })
      }
      return new Response(JSON.stringify({ accepted: 1 }), { status: 200 })
    }))
    const targetUsfm = "\\id GEN\n\\c 1\n\\s Creation\n\\p\n\\v 1 Au commencement.\n"
    const packageBytes = new TextEncoder().encode("complete paratext package").buffer
    const plan = {
      project: {
        settings: {
          name: "fra",
          fullName: "French",
          language: "French",
          languageIsoCode: "fra",
          versification: "4",
          encoding: "65001",
          rightToLeft: false,
          naming: { prePart: "", postPart: ".SFM", bookNameForm: "41MAT" },
        },
        bookNames: new Map(),
        books: [{
          fileName: "01GEN.SFM",
          bookId: "GEN",
          displayName: "Genesis",
          corpusMarker: "OT",
          order: 0,
          rawSource: targetUsfm,
          verseCount: 1,
        }],
      },
      books: [],
      sourceArtifact: {
        name: "French.zip",
        format: "paratext-project",
        bytes: async () => packageBytes,
      },
    } as ParatextPlan

    const result = await importParatextAsTarget(
      plan,
      [{ ref: "GEN 1:1", text: "In the beginning." }],
      { projectId: "p1", author: "alice", targetLang: "fr", getToken: async () => "tok" },
    )

    expect(result.refs).toHaveLength(1)
    expect(result.skipped).toEqual([])
    const staged = calls.findIndex((call) => call.body?.complete && !call.body.publishEventId)
    const published = calls.findIndex((call) => typeof call.body?.publishEventId === "string")
    const sourceUploads = calls
      .map((call, index) => ({ ...call, index }))
      .filter((call) => call.url.includes("/source") && !call.url.includes("source-bindings"))
    expect(sourceUploads).toHaveLength(2)
    expect(sourceUploads[0].init?.headers).toMatchObject({
      "X-Artifact-Binding-Role": "target",
      "X-Artifact-Target-Lang": "fr",
    })
    expect(new TextDecoder().decode(sourceUploads[0].init?.body as ArrayBuffer)).toBe(targetUsfm)
    expect(sourceUploads[1].init?.headers).toMatchObject({
      "X-Artifact-Binding-Role": "target",
      "X-Artifact-Target-Lang": "fr",
      "X-Update-Source-Sidecar": "false",
    })
    expect(staged).toBeGreaterThan(-1)
    expect(published).toBeGreaterThan(sourceUploads[1].index)
  })
})
