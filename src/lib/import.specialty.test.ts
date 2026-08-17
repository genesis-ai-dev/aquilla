import { afterEach, describe, expect, it, vi } from "vitest"
import { importMacula, importObs, importTranslationNotes } from "./import"

const MACULA = `ref\ttext\tlemma\tmorph\tstrongnumber
GEN 1:1!1\tבְּרֵאשִׁית\tרֵאשִׁית\tHR/Ncfsa\tH7225`

const NOTES = `Book\tChapter\tVerse\tID\tNote
GEN\t1\t1\tnote-1\tAn exact note.`

afterEach(() => vi.unstubAllGlobals())

function successfulResponse(url: string): Response {
  return url.includes("/source")
    ? new Response(JSON.stringify({ artifactId: "a", key: "k", sha256: "f".repeat(64) }), { status: 200 })
    : new Response(JSON.stringify({ accepted: 1 }), { status: 200 })
}

describe("specialty import durability", () => {
  it.each([
    ["Macula", importMacula],
    ["Translation Notes", importTranslationNotes],
  ])("rejects an oversized %s file before buffering or creating server state", async (_label, importer) => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0))
    const file = {
      name: "oversized.tsv",
      size: 96 * 1024 * 1024,
      arrayBuffer,
    } as unknown as File
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(importer(
      file,
      { projectId: "p1", author: "alice", getToken: async () => "tok" },
    )).rejects.toThrow(/95\.0 MB limit/)
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("keeps Macula staged when required morphology fails", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init })
      if (url.endsWith("/import-morph")) return new Response("morph unavailable", { status: 500 })
      return successfulResponse(url)
    }))

    await expect(importMacula(
      new File([MACULA], "GEN.tsv", { type: "text/tab-separated-values" }),
      { projectId: "p1", author: "alice", getToken: async () => "tok" },
    )).rejects.toThrow(/Morph upload failed/)

    const sourceUpload = requests.find((request) => request.url.includes("/source"))
    expect(sourceUpload?.init?.headers).toMatchObject({ "X-Source-Format": "macula-tsv" })
    expect(new TextDecoder().decode(sourceUpload?.init?.body as ArrayBuffer)).toBe(MACULA)
    const finalizations = requests
      .filter((request) => request.url.endsWith("/import"))
      .map((request) => JSON.parse(String(request.init?.body)))
      .filter((body) => body.complete)
    expect(finalizations).toHaveLength(1)
    expect(finalizations[0].publishEventId).toBeUndefined()
  })

  it("preserves Translation Notes bytes with their specialty format", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init })
      return successfulResponse(url)
    }))

    await importTranslationNotes(
      new File([NOTES], "tn_GEN.tsv", { type: "text/tab-separated-values" }),
      { projectId: "p1", author: "alice", getToken: async () => "tok" },
    )

    const sourceUpload = requests.find((request) => request.url.includes("/source"))
    expect(sourceUpload?.init?.headers).toMatchObject({ "X-Source-Format": "tn-tsv" })
    expect(new TextDecoder().decode(sourceUpload?.init?.body as ArrayBuffer)).toBe(NOTES)
    const published = requests
      .filter((request) => request.url.endsWith("/import"))
      .map((request) => JSON.parse(String(request.init?.body)))
      .some((body) => body.complete && typeof body.publishEventId === "string")
    expect(published).toBe(true)
  })

  it("does not publish a silently incomplete OBS collection", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/contents/content")) {
        return new Response(JSON.stringify([
          { type: "file", name: "01.md", path: "content/01.md" },
          { type: "file", name: "02.md", path: "content/02.md" },
        ]), { status: 200 })
      }
      if (url.endsWith("/content/01.md")) {
        return new Response("# Story\n\n![image](https://example.test/1.jpg)\n\nFrame one.", { status: 200 })
      }
      return new Response("unavailable", { status: 503 })
    })
    vi.stubGlobal("fetch", fetchMock)

    await expect(importObs({
      projectId: "p1",
      author: "alice",
      getToken: async () => "tok",
    })).rejects.toThrow(/download was incomplete.*02\.md.*nothing was imported/i)

    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/import"))).toBe(false)
  })
})
