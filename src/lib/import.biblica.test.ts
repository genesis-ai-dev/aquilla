import { afterEach, describe, expect, it, vi } from "vitest"
import {
  SAMPLE_FRONT_MATTER,
  SAMPLE_FRONT_MATTER_AARON,
  SAMPLE_NOTES,
  biblicaFrontMatterStory,
  closedVerse,
  makeBiblicaIdml,
  note,
  paragraph,
  run,
} from "./biblica/__fixtures__/biblica-idml"

// The production path parses in a transferable Web Worker, which does not exist
// in this runtime. Run the identical shared engine inline so the commit path is
// exercised against real parsed units rather than a hand-built fixture.
vi.mock("@/lib/idml/idml-worker-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/idml/idml-worker-client")>()
  const { parseIdml } = await import("@aquilla/idml-roundtrip")
  return {
    ...actual,
    parseIdmlInWorker: (
      bytes: ArrayBuffer,
      profile: "generic" | "biblica" = "generic",
      options?: { signal?: AbortSignal },
    ) => parseIdml(bytes, profile, options),
  }
})

const { importBiblicaStudyNotes, BIBLICA_NOTES_PROFILE_ID } = await import("./import")

afterEach(() => vi.unstubAllGlobals())

function successfulResponse(url: string): Response {
  return url.includes("/source")
    ? new Response(
        JSON.stringify({ artifactId: "a", key: "k", sha256: "f".repeat(64) }),
        { status: 200 },
      )
    : new Response(JSON.stringify({ accepted: 1 }), { status: 200 })
}

function captureRequests(): Array<{ url: string; init?: RequestInit }> {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, init })
    return successfulResponse(url)
  }))
  return requests
}

async function biblicaFile(paragraphs?: readonly string[]): Promise<File> {
  const bytes = await makeBiblicaIdml(paragraphs)
  return new File([bytes], "Genesis-notes.idml", {
    type: "application/vnd.adobe.indesign-idml-package",
  })
}

function importBodies(requests: Array<{ url: string; init?: RequestInit }>) {
  return requests
    .filter((request) => request.url.endsWith("/import"))
    .map((request) => JSON.parse(String(request.init?.body)) as {
      file?: { fileType?: string; kind?: string; parserVersion?: string; bookCode?: string }
      cells?: Array<{ cellId: string; value: string; metadata?: Record<string, unknown> }>
      complete?: boolean
      publishEventId?: string
    })
}

describe("Biblica study-notes import", () => {
  it("commits only the study notes, preserving the original package as the source artifact", async () => {
    const requests = captureRequests()
    const file = await biblicaFile()
    const originalBytes = new Uint8Array(await file.arrayBuffer())

    const ref = await importBiblicaStudyNotes(file, {
      projectId: "p1",
      author: "alice",
      getToken: async () => "tok",
    })

    expect(ref.type).toBe("idml")
    // The trailing "-notes" is dropped so the file reads as the book it covers.
    expect(ref.name).toBe("Genesis")
    expect(ref.cellCount).toBe(9)

    const bodies = importBodies(requests)
    const meta = bodies.find((body) => body.file)?.file
    expect(meta).toMatchObject({
      fileType: "idml",
      kind: "idml",
      parserVersion: `${BIBLICA_NOTES_PROFILE_ID}@1`,
      bookCode: "GEN",
    })

    const cells = bodies.flatMap((body) => body.cells ?? [])
    expect(cells.map((cell) => cell.value)).toEqual([
      SAMPLE_NOTES.preface,
      SAMPLE_NOTES.afterChapterOne,
      SAMPLE_NOTES.afterChaptersTwoToThree,
      SAMPLE_NOTES.psalmHeading,
      SAMPLE_NOTES.psalmNote,
      // A list set as one paragraph is committed as one cell per line.
      ...SAMPLE_NOTES.referenceList,
      SAMPLE_NOTES.noteBlock,
    ])

    // Scripture must never reach the project as a translatable cell.
    const committed = cells.map((cell) => cell.value).join("\n")
    expect(committed).not.toContain("In the beginning God created")
    expect(committed).not.toContain("No shrub had yet appeared")
    expect(committed).not.toContain("working the ground")

    // Whole-package bytes are preserved under the IDML artifact format, so a
    // strict round-trip export still has the original to write back into.
    const sourceUpload = requests.find((request) => request.url.includes("/source"))
    expect(sourceUpload?.init?.headers).toMatchObject({ "X-Source-Format": "idml" })
    expect(new Uint8Array(sourceUpload?.init?.body as ArrayBuffer)).toEqual(originalBytes)

    expect(bodies.some((body) => body.complete && typeof body.publishEventId === "string")).toBe(true)
  })

  it("carries each note's chapter-range label and locator into the committed cell metadata", async () => {
    const requests = captureRequests()

    await importBiblicaStudyNotes(await biblicaFile(), {
      projectId: "p1",
      author: "alice",
      getToken: async () => "tok",
    })

    const cells = importBodies(requests).flatMap((body) => body.cells ?? [])
    expect(cells.map((cell) => (cell.metadata?.biblica as { chapterLabel?: string })?.chapterLabel))
      .toEqual(["Preface", "1", "2-3", "2", "2", "2", "2", "2", "2"])
    for (const cell of cells) {
      expect(cell.metadata?.idml).toMatchObject({ version: 2 })
      expect(cell.metadata?.aquillaImport).toMatchObject({
        profileId: BIBLICA_NOTES_PROFILE_ID,
        profileVersion: "1",
        fidelity: "content-only",
        sourceLocator: { kind: "idml" },
      })
    }

    // Lines of one paragraph are distinct cells that address the same block at
    // different parts, so the import manifest keeps them individually addressable.
    const listCells = cells.filter((cell) => SAMPLE_NOTES.referenceList.includes(
      cell.value as (typeof SAMPLE_NOTES.referenceList)[number],
    ))
    expect(listCells).toHaveLength(3)
    const addresses = listCells.map((cell) => (
      (cell.metadata?.aquillaImport as { address?: { blockPath?: string; segment?: number } })
        ?.address
    ))
    expect(new Set(addresses.map((address) => address?.blockPath)).size).toBe(1)
    expect(addresses.map((address) => address?.segment)).toEqual([1, 2, 3])
  })

  it("commits a multi-sentence note block as one cell when sentence splitting is off", async () => {
    const requests = captureRequests()

    await importBiblicaStudyNotes(
      await biblicaFile(),
      { projectId: "p1", author: "alice", getToken: async () => "tok" },
      undefined,
      { splitSentences: false },
    )

    const cells = importBodies(requests).flatMap((body) => body.cells ?? [])
    expect(cells.map((cell) => cell.value)).toEqual([
      SAMPLE_NOTES.preface,
      SAMPLE_NOTES.afterChapterOne,
      SAMPLE_NOTES.afterChaptersTwoToThree,
      SAMPLE_NOTES.psalmHeading,
      SAMPLE_NOTES.psalmNote,
      ...SAMPLE_NOTES.referenceList,
      SAMPLE_NOTES.noteBlock,
    ])
    expect(cells).toHaveLength(9)
    const block = cells.find((cell) => cell.value === SAMPLE_NOTES.noteBlock)
    expect(block?.metadata?.idmlRejoin).toBeUndefined()
  })

  it("commits the sentences of a note block as distinct cells that can be rejoined", async () => {
    const requests = captureRequests()

    await importBiblicaStudyNotes(
      await biblicaFile(),
      { projectId: "p1", author: "alice", getToken: async () => "tok" },
      undefined,
      { splitSentences: true },
    )

    const cells = importBodies(requests).flatMap((body) => body.cells ?? [])
    const sentenceCells = cells.filter((cell) => (
      (SAMPLE_NOTES.noteBlockSentences as readonly string[]).includes(cell.value)
    ))
    expect(sentenceCells).toHaveLength(3)

    // A sentence is not addressable in IDML, so all three share one document
    // address — and therefore need distinct cell and unit keys of their own.
    const imports = sentenceCells.map((cell) => cell.metadata?.aquillaImport as {
      unitKey?: string
      address?: { blockPath?: string; segment?: number }
    })
    expect(new Set(imports.map((entry) => (
      `${entry.address?.blockPath}#${entry.address?.segment}`
    ))).size).toBe(1)
    expect(new Set(imports.map((entry) => entry.unitKey)).size).toBe(3)
    expect(new Set(sentenceCells.map((cell) => cell.cellId)).size).toBe(3)

    // The bucket export needs to put the block back together is persisted.
    expect(sentenceCells.map((cell) => cell.metadata?.idmlRejoin)).toEqual([
      { version: 1, index: 0, count: 3, ranges: [expect.objectContaining({ slot: 0 })] },
      { version: 1, index: 1, count: 3, ranges: [expect.objectContaining({ slot: 0 })] },
      { version: 1, index: 2, count: 3, ranges: [expect.objectContaining({ slot: 0 })] },
    ])
  })

  it("rejects an oversized package before buffering or creating server state", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0))
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(importBiblicaStudyNotes(
      { name: "huge.idml", size: 96 * 1024 * 1024, arrayBuffer } as unknown as File,
      { projectId: "p1", author: "alice", getToken: async () => "tok" },
    )).rejects.toThrow(/95 MB limit/)
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects a file that is not an IDML package without creating server state", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const ctx = { projectId: "p1", author: "alice", getToken: async () => "tok" }

    await expect(importBiblicaStudyNotes(
      new File(["Book\tChapter\n"], "notes.tsv"),
      ctx,
    )).rejects.toThrow(/\.idml package/)

    await expect(importBiblicaStudyNotes(
      new File(["not a zip at all"], "notes.idml"),
      ctx,
    )).rejects.toThrow(/not a valid IDML package/)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("commits a front/back-matter volume as all of its text, sectioned by its headings", async () => {
    const requests = captureRequests()

    const ref = await importBiblicaStudyNotes(
      await biblicaFile(biblicaFrontMatterStory),
      { projectId: "p1", author: "alice", getToken: async () => "tok" },
    )

    const cells = importBodies(requests).flatMap((body) => body.cells ?? [])
    expect(ref.cellCount).toBe(10)
    expect(cells.map((cell) => cell.value)).toEqual([
      SAMPLE_FRONT_MATTER.title,
      ...SAMPLE_FRONT_MATTER.contents,
      SAMPLE_FRONT_MATTER.letterA,
      SAMPLE_FRONT_MATTER_AARON,
      SAMPLE_FRONT_MATTER.letterB,
      SAMPLE_FRONT_MATTER.babel,
      SAMPLE_FRONT_MATTER.usageHeading,
      SAMPLE_FRONT_MATTER.usageBody,
    ])
    // The running head is page furniture InDesign regenerates: no cell anywhere.
    expect(cells.some((cell) => cell.value.includes(SAMPLE_FRONT_MATTER.runningHead))).toBe(false)

    // Each heading is a section in the editor's navigation, and the heading
    // itself is an editable cell inside the section it opened.
    expect(cells.map((cell) => (
      (cell.metadata?.aquillaImport as { milestone?: { key?: string } })?.milestone?.key
    ))).toEqual([
      ...Array(4).fill("biblica:front-matter:Opening"),
      "biblica:front-matter:A",
      "biblica:front-matter:A",
      "biblica:front-matter:B",
      "biblica:front-matter:B",
      ...Array(2).fill(`biblica:front-matter:${SAMPLE_FRONT_MATTER.usageHeading}`),
    ])
    expect(cells[4]?.metadata?.aquillaImport).toMatchObject({
      profileId: BIBLICA_NOTES_PROFILE_ID,
      fidelity: "content-only",
      sourceLocator: { kind: "idml" },
      milestone: { kind: "section", label: "A", shortLabel: "A" },
    })
  })

  it("explains that an artwork-only front/back-matter volume has nothing to import", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const artworkOnly = await biblicaFile([
      paragraph("p-rh", "meta%3arh", run("$ID/[No character style]", "MAPS 3")),
    ])

    await expect(importBiblicaStudyNotes(artworkOnly, {
      projectId: "p1",
      author: "alice",
      getToken: async () => "tok",
    })).rejects.toThrow(/contained no translatable text/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("explains that a package with no intro paragraphs holds no notes", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const scriptureOnly = await biblicaFile([
      paragraph("p-bk", "meta%3abk", run("$ID/[No character style]", "GEN")),
      paragraph("p-rh", "meta%3arh", run("$ID/[No character style]", "GENESIS 1")),
      // Marked scripture is what makes this a notes volume rather than a
      // front/back-matter one, which is read as all of its text instead.
      closedVerse("p-v1", "1", "In the beginning God created the heavens and the earth.", "1"),
    ])

    await expect(importBiblicaStudyNotes(scriptureOnly, {
      projectId: "p1",
      author: "alice",
      getToken: async () => "tok",
    })).rejects.toThrow(/contained no study notes/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("imports notes from a package that never names a book", async () => {
    const requests = captureRequests()
    const unnamed = await biblicaFile([
      note("p-n", "A standalone note."),
      // No `meta:bk`, but marked scripture: a notes volume with no book name.
      closedVerse("p-v1", "1", "In the beginning God created the heavens and the earth.", "1"),
    ])

    const ref = await importBiblicaStudyNotes(unnamed, {
      projectId: "p1",
      author: "alice",
      getToken: async () => "tok",
    })

    expect(ref.cellCount).toBe(1)
    const cell = importBodies(requests).flatMap((body) => body.cells ?? [])[0]
    const meta = importBodies(requests).find((body) => body.file)?.file
    expect(meta?.bookCode).toBeUndefined()
    expect(cell?.metadata?.aquillaImport).toMatchObject({
      milestone: {
        key: "biblica:unknown:Preface",
        kind: "preface",
        label: "Preface",
        shortLabel: "P",
      },
    })
  })
})
