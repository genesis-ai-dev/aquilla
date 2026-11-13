import { afterEach, describe, expect, it, vi } from "vitest"
import { importMacula, importObs, importTranslationNotes } from "./import"
import { isTranslationNotesFile } from "./notes/note-files"

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

  // AQU-2487 (browser pass, Nov 12, and its review): a file whose rows give
  // only "1:1" was refused with the sentence about the first three columns
  // whenever its name didn't give one book, which sends the person to the
  // wrong place. The refusal names the file name instead: the books in it when
  // it holds more than one, else that it doesn't say the book. Rows that are
  // wrong themselves keep the columns sentence.
  it("refuses a Translation Notes file by its name when the rows need the book from it and the name doesn't give one", async () => {
    const current = "Reference\tID\tNote\n1:1\tabc1\tA note.\n1:2\tabc2\tAnother."
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const ctx = { projectId: "p1", author: "alice", getToken: async () => "tok" }
    const refusal = async (name: string, text = current): Promise<string> => {
      try {
        await importTranslationNotes(new File([text], name), ctx)
        return "(imported)"
      } catch (e) {
        return (e as Error).message
      }
    }
    const twoBooks = (books: string, example: string) =>
      `The file name holds more than one book (${books}), so the notes can't be filed under one. ` +
      `Rename the file so it names one book, such as ${example}.`
    const noBook = "The file name doesn't say which book these notes are for. Rename the file to name one book, such as tn_GEN.tsv."

    expect(await refusal("tn_GEN_rev.tsv")).toBe(twoBooks("GEN, REV", "tn_GEN.tsv"))
    expect(await refusal("rev_tn_GEN.tsv")).toBe(twoBooks("GEN, REV", "tn_GEN.tsv"))
    expect(await refusal("GEN_REV.tsv")).toBe(twoBooks("GEN, REV", "tn_GEN.tsv"))
    for (const name of ["Titus notes.tsv", "my_new_notes.tsv", "notes_job.tsv", "GEN_tn.tsv", "tn_en_GEN.tsv"]) {
      expect(await refusal(name), name).toBe(noBook)
    }
    // No reference at all, or three columns with the book left blank.
    expect(await refusal("tn_GEN_rev.tsv", "Reference\tID\tNote\n\tx\tA note.")).toMatch(/first three columns/)
    expect(await refusal("tn_GEN_rev.tsv", "Book\tChapter\tVerse\tNote\n\t1\t1\tA note.")).toMatch(/first three columns/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // AQU-527 seam: the notes sidebar only reads files `isTranslationNotesFile`
  // accepts. The importer sends `fileType: "tsv"` AND `kind: "translation-notes"`;
  // the server stores `kind ?? fileType` and the files read route answers
  // `fileType: kind ?? role` (sync-worker `files-read-route.ts`) — so the row the
  // sidebar sees says "translation-notes", not "tsv". This passes what the real
  // importer posts through that resolution into the sidebar's own predicate, so
  // a renamed kind fails here instead of silently emptying the panel.
  it("creates a Translation Notes file the notes sidebar recognises", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init })
      return successfulResponse(url)
    }))

    await importTranslationNotes(
      new File([NOTES], "tn_GEN.tsv", { type: "text/tab-separated-values" }),
      { projectId: "p1", author: "alice", getToken: async () => "tok" },
    )

    const posted = requests
      .filter((request) => request.url.endsWith("/import"))
      .map((request) => JSON.parse(String(request.init?.body)) as {
        file?: { fileType?: string; role?: string; kind?: string }
      })
      .find((body) => body.file)?.file
    expect(posted).toBeDefined()
    const storedKind = posted?.kind ?? posted?.fileType ?? null
    const fileTypeOnRead = storedKind ?? posted?.role ?? "codex"
    expect(fileTypeOnRead).toBe("translation-notes")
    expect(isTranslationNotesFile({ fileType: fileTypeOnRead })).toBe(true)
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
