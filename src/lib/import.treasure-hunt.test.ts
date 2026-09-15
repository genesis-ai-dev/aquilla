import { afterEach, describe, expect, it, vi } from "vitest"
import {
  SAMPLE_TREASURE_HUNT,
  blockHead,
  makeTreasureHuntIdml,
  note,
  paragraph,
  run,
  scripture,
} from "./biblica/treasure-hunt/__fixtures__/treasure-hunt-idml"

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

const { importBiblicaStudyNotes, TREASURE_HUNT_PROFILE_ID } = await import("./import")

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

async function treasureHuntFile(paragraphs?: readonly string[]): Promise<File> {
  const bytes = await makeTreasureHuntIdml(paragraphs)
  return new File([bytes], "ukNIRV13_THB-01-05-Gen-Deu.idml", {
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

const ctx = { projectId: "p1", author: "alice", getToken: async () => "tok" }

describe("Treasure Hunt Bible import", () => {
  it("commits everything around the Bible text, preserving the package as the source artifact", async () => {
    const requests = captureRequests()
    const file = await treasureHuntFile()
    const originalBytes = new Uint8Array(await file.arrayBuffer())

    const ref = await importBiblicaStudyNotes(file, ctx, undefined, { edition: "treasure-hunt" })

    expect(ref.type).toBe("idml")
    expect(ref.cellCount).toBe(17)

    const bodies = importBodies(requests)
    expect(bodies.find((body) => body.file)?.file).toMatchObject({
      fileType: "idml",
      kind: "idml",
      parserVersion: `${TREASURE_HUNT_PROFILE_ID}@1`,
      bookCode: "GEN",
      corpusMarker: "Treasure Hunt Bible",
    })

    const cells = bodies.flatMap((body) => body.cells ?? [])
    expect(cells.map((cell) => cell.value)).toEqual([
      SAMPLE_TREASURE_HUNT.frontMatterTitle,
      SAMPLE_TREASURE_HUNT.frontMatter,
      SAMPLE_TREASURE_HUNT.introSection,
      SAMPLE_TREASURE_HUNT.introBook,
      SAMPLE_TREASURE_HUNT.introHead,
      // A list set as one paragraph is committed as one cell per line.
      ...SAMPLE_TREASURE_HUNT.introList,
      SAMPLE_TREASURE_HUNT.factHead,
      // A multi-sentence fact block is committed as one cell per sentence.
      ...SAMPLE_TREASURE_HUNT.factBlockSentences,
      SAMPLE_TREASURE_HUNT.huntHead,
      SAMPLE_TREASURE_HUNT.huntNote,
      ...SAMPLE_TREASURE_HUNT.huntSteps,
      SAMPLE_TREASURE_HUNT.rangeHead,
      "Read these chapters and draw what you find.",
    ])

    // The published Bible text must never reach the project as a translatable cell.
    const committed = cells.map((cell) => cell.value).join("\n")
    expect(committed).not.toContain(SAMPLE_TREASURE_HUNT.scriptureBody)
    expect(committed).not.toContain(SAMPLE_TREASURE_HUNT.scriptureHead)

    // Whole-package bytes are preserved under the IDML artifact format, so a
    // strict round-trip export still has the original to write back into.
    const sourceUpload = requests.find((request) => request.url.includes("/source"))
    expect(sourceUpload?.init?.headers).toMatchObject({ "X-Source-Format": "idml" })
    expect(new Uint8Array(sourceUpload?.init?.body as ArrayBuffer)).toEqual(originalBytes)

    expect(bodies.some((body) => body.complete && typeof body.publishEventId === "string")).toBe(true)
  })

  it("carries each note's chapter label, edition and locator into the committed metadata", async () => {
    const requests = captureRequests()

    await importBiblicaStudyNotes(await treasureHuntFile(), ctx, undefined, { edition: "treasure-hunt" })

    const cells = importBodies(requests).flatMap((body) => body.cells ?? [])
    expect(cells.map((cell) => (cell.metadata?.biblica as { chapterLabel?: string })?.chapterLabel))
      .toEqual([
        "Intro", "Intro", "Intro", "Intro", "Intro", "Intro", "Intro",
        "1", "1", "1", "1",
        "3", "3", "3", "3",
        "1-3", "1-3",
      ])
    for (const cell of cells) {
      expect(cell.metadata?.biblica).toMatchObject({ edition: "treasure-hunt" })
      expect(cell.metadata?.idml).toMatchObject({ version: 2 })
      expect(cell.metadata?.aquillaImport).toMatchObject({
        profileId: TREASURE_HUNT_PROFILE_ID,
        profileVersion: "1",
        fidelity: "content-only",
        sourceLocator: { kind: "idml" },
      })
    }
  })

  it("plans navigation milestones from the passage each block heading named", async () => {
    const requests = captureRequests()

    await importBiblicaStudyNotes(await treasureHuntFile(), ctx, undefined, { edition: "treasure-hunt" })

    const cells = importBodies(requests).flatMap((body) => body.cells ?? [])
    const milestoneOf = (value: string) => (
      (cells.find((cell) => cell.value === value)?.metadata?.aquillaImport as {
        milestone?: { key?: string; kind?: string; label?: string; shortLabel?: string }
      })?.milestone
    )

    expect(milestoneOf(SAMPLE_TREASURE_HUNT.introHead)).toEqual({
      key: "biblica:GEN:Intro",
      kind: "preface",
      label: "Genesis Intro",
      shortLabel: "I",
    })
    expect(milestoneOf(SAMPLE_TREASURE_HUNT.huntNote)).toEqual({
      key: "biblica:GEN:3",
      kind: "chapter",
      label: "Genesis 3",
      shortLabel: "3",
    })
    expect(milestoneOf(SAMPLE_TREASURE_HUNT.rangeHead)).toEqual({
      key: "biblica:GEN:1-3",
      kind: "chapter-range",
      label: "Genesis 1\u20133",
      shortLabel: "1\u20133",
    })
  })

  it("commits a multi-sentence fact block as one cell when sentence splitting is off", async () => {
    const requests = captureRequests()

    await importBiblicaStudyNotes(await treasureHuntFile(), ctx, undefined, {
      edition: "treasure-hunt",
      splitSentences: false,
    })

    const cells = importBodies(requests).flatMap((body) => body.cells ?? [])
    expect(cells.map((cell) => cell.value)).toContain(SAMPLE_TREASURE_HUNT.factBlock)
    expect(cells).toHaveLength(15)
    expect(cells.find((cell) => (
      cell.value === SAMPLE_TREASURE_HUNT.factBlock
    ))?.metadata?.idmlRejoin).toBeUndefined()
  })

  it("commits the sentences of a fact block as distinct cells that can be rejoined", async () => {
    const requests = captureRequests()

    await importBiblicaStudyNotes(await treasureHuntFile(), ctx, undefined, { edition: "treasure-hunt" })

    const cells = importBodies(requests).flatMap((body) => body.cells ?? [])
    const sentenceCells = cells.filter((cell) => (
      (SAMPLE_TREASURE_HUNT.factBlockSentences as readonly string[]).includes(cell.value)
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
    expect(sentenceCells.map((cell) => cell.metadata?.idmlRejoin)).toEqual([
      { version: 1, index: 0, count: 3, ranges: [expect.objectContaining({ slot: 0 })] },
      { version: 1, index: 1, count: 3, ranges: [expect.objectContaining({ slot: 0 })] },
      { version: 1, index: 2, count: 3, ranges: [expect.objectContaining({ slot: 0 })] },
    ])
  })

  it("reads the same package as the study-Bible importer would when the toggle is off", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    // A Treasure Hunt volume has no `intro:*` paragraphs, which is the failure
    // the toggle exists to resolve — so the message has to point at the toggle.
    await expect(importBiblicaStudyNotes(await treasureHuntFile(), ctx))
      .rejects.toThrow(/Treasure Hunt Bible, a Reach 4 Life or an EBL file/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("explains that a volume with no apparatus holds no Treasure Hunt notes", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const scriptureOnly = await treasureHuntFile([
      scripture("v1", "In the beginning, God created the heavens and the earth.", {
        chapter: "1",
        verse: "1",
      }),
      paragraph("p-pn", "#pn", run("$ID/[No character style]", "18")),
    ])

    await expect(importBiblicaStudyNotes(scriptureOnly, ctx, undefined, { edition: "treasure-hunt" }))
      .rejects.toThrow(/contained no Treasure Hunt notes/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects a file that is not an IDML package without creating server state", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(importBiblicaStudyNotes(
      new File(["Book\tChapter\n"], "notes.tsv"),
      ctx,
      undefined,
      { edition: "treasure-hunt" },
    )).rejects.toThrow(/\.idml package/)

    await expect(importBiblicaStudyNotes(
      new File(["not a zip at all"], "notes.idml"),
      ctx,
      undefined,
      { edition: "treasure-hunt" },
    )).rejects.toThrow(/not a valid IDML package/)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("imports front matter from a volume that never names a book", async () => {
    const requests = captureRequests()
    const frontMatterOnly = await treasureHuntFile([
      paragraph("p-fm", "par", run("$ID/[No character style]", "This Bible belongs to")),
    ])

    const ref = await importBiblicaStudyNotes(frontMatterOnly, ctx, undefined, {
      edition: "treasure-hunt",
    })

    expect(ref.cellCount).toBe(1)
    expect(importBodies(requests).find((body) => body.file)?.file?.bookCode).toBeUndefined()
    expect(importBodies(requests).flatMap((body) => body.cells ?? [])[0]?.metadata?.aquillaImport)
      .toMatchObject({
        milestone: {
          key: "biblica:unknown:Intro",
          kind: "preface",
          label: "Intro",
          shortLabel: "I",
        },
      })
  })

  it("imports the notes from a volume that carries several books", async () => {
    const requests = captureRequests()
    const multiBook = await treasureHuntFile([
      blockHead("h1", "Genesis 1:1"),
      note("n1", "God made everything there is."),
      blockHead("h2", "Exodus 3:1\u201312", true),
      note("n2", "Moses met God at a burning bush."),
      blockHead("h3", "Deuteronomy 6:4\u20139"),
      note("n3", "Love the Lord your God with all your heart."),
    ])

    await importBiblicaStudyNotes(multiBook, ctx, undefined, { edition: "treasure-hunt" })

    const bodies = importBodies(requests)
    // A volume covering several books gets no single book code on the file.
    expect(bodies.find((body) => body.file)?.file?.bookCode).toBeUndefined()
    expect(bodies.flatMap((body) => body.cells ?? []).map((cell) => (
      (cell.metadata?.aquillaImport as { milestone?: { key?: string } })?.milestone?.key
    ))).toEqual([
      "biblica:GEN:1", "biblica:GEN:1",
      "biblica:EXO:3", "biblica:EXO:3",
      "biblica:DEU:6", "biblica:DEU:6",
    ])
  })
})
