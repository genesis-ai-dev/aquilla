import { afterEach, describe, expect, it, vi } from "vitest"
import {
  SAMPLE_REACH4LIFE,
  makeReach4LifeIdml,
  reach4LifeWorkbookSampleStory,
  scripture,
  styled,
} from "./biblica/reach4life/__fixtures__/reach4life-idml"
import { makeTreasureHuntIdml } from "./biblica/treasure-hunt/__fixtures__/treasure-hunt-idml"
import { makeBiblicaIdml } from "./biblica/__fixtures__/biblica-idml"

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

const { importBiblicaStudyNotes, REACH4LIFE_PROFILE_ID } = await import("./import")

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

async function reach4LifeFile(
  paragraphs?: readonly string[],
  name = "40MAT-43JHN_ukNIRV-120x180mm_BLUE.idml",
): Promise<File> {
  const bytes = await makeReach4LifeIdml(paragraphs)
  return new File([bytes], name, {
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

describe("Reach 4 Life import", () => {
  it("commits the workbook around the Bible text, preserving the package as the source artifact", async () => {
    const requests = captureRequests()
    const file = await reach4LifeFile()
    const originalBytes = new Uint8Array(await file.arrayBuffer())

    const ref = await importBiblicaStudyNotes(file, ctx, undefined, { edition: "reach4life" })

    expect(ref.type).toBe("idml")
    expect(ref.cellCount).toBe(13)

    const bodies = importBodies(requests)
    expect(bodies.find((body) => body.file)?.file).toMatchObject({
      fileType: "idml",
      kind: "idml",
      parserVersion: `${REACH4LIFE_PROFILE_ID}@1`,
      corpusMarker: "Reach 4 Life",
    })
    // Two books are introduced here, so no single book identifies the file.
    expect(bodies.find((body) => body.file)?.file?.bookCode).toBeUndefined()

    const cells = bodies.flatMap((body) => body.cells ?? [])
    expect(cells.map((cell) => cell.value)).toEqual([
      SAMPLE_REACH4LIFE.bookStrapline,
      SAMPLE_REACH4LIFE.bookTitle,
      SAMPLE_REACH4LIFE.bookIntroHead,
      SAMPLE_REACH4LIFE.bookIntroBody,
      SAMPLE_REACH4LIFE.bookStrapline,
      SAMPLE_REACH4LIFE.secondBookTitle,
      SAMPLE_REACH4LIFE.secondBookIntroHead,
      SAMPLE_REACH4LIFE.copyright,
      // A contents block set as one paragraph is committed one cell per line.
      ...SAMPLE_REACH4LIFE.contentsEntries,
      SAMPLE_REACH4LIFE.readingGuideHead,
      SAMPLE_REACH4LIFE.readingGuide,
    ])

    // The published Bible text must never reach the project as a translatable cell.
    const committed = cells.map((cell) => cell.value).join("\n")
    expect(committed).not.toContain(SAMPLE_REACH4LIFE.scriptureBody)
    expect(committed).not.toContain(SAMPLE_REACH4LIFE.scriptureHead)
    expect(committed).not.toContain(SAMPLE_REACH4LIFE.scriptureVerse)

    // Whole-package bytes are preserved under the IDML artifact format, so a
    // strict round-trip export still has the original to write back into.
    const sourceUpload = requests.find((request) => request.url.includes("/source"))
    expect(sourceUpload?.init?.headers).toMatchObject({ "X-Source-Format": "idml" })
    expect(new Uint8Array(sourceUpload?.init?.body as ArrayBuffer)).toEqual(originalBytes)

    expect(bodies.some((body) => body.complete && typeof body.publishEventId === "string")).toBe(true)
  })

  it("commits a workbook section's lessons, quoted verses included", async () => {
    const requests = captureRequests()

    await importBiblicaStudyNotes(
      await reach4LifeFile(reach4LifeWorkbookSampleStory, "ukEngR4Lv4_NT_FRT SECTION.idml"),
      ctx,
      undefined,
      { edition: "reach4life" },
    )

    const cells = importBodies(requests).flatMap((body) => body.cells ?? [])
    expect(cells.map((cell) => cell.value)).toEqual([
      SAMPLE_REACH4LIFE.lessonTitle,
      ...SAMPLE_REACH4LIFE.lessonBlockSentences,
      SAMPLE_REACH4LIFE.lessonQuote,
      SAMPLE_REACH4LIFE.lessonQuoteRef,
      SAMPLE_REACH4LIFE.storyTitle,
      SAMPLE_REACH4LIFE.storyBody,
      SAMPLE_REACH4LIFE.psalmHeading,
    ])
    // The Psalms reading is continuous scripture and stays out.
    const committed = cells.map((cell) => cell.value).join("\n")
    expect(committed).not.toContain(SAMPLE_REACH4LIFE.psalmLine)
    expect(committed).not.toContain(SAMPLE_REACH4LIFE.psalmSuperscription)
  })

  it("carries each cell's section, edition and locator into the committed metadata", async () => {
    const requests = captureRequests()

    await importBiblicaStudyNotes(await reach4LifeFile(), ctx, undefined, { edition: "reach4life" })

    const cells = importBodies(requests).flatMap((body) => body.cells ?? [])
    expect(cells.map((cell) => (cell.metadata?.biblica as { sectionId?: string })?.sectionId))
      .toEqual([
        "bbi bible book intros", "bbi bible book intros", "bbi bible book intros",
        "bbi bible book intros", "bbi bible book intros", "bbi bible book intros",
        "bbi bible book intros",
        "copyright",
        "additional", "additional", "additional",
        "intros", "intros",
      ])
    for (const cell of cells) {
      expect(cell.metadata?.biblica).toMatchObject({ edition: "reach4life" })
      expect(cell.metadata?.idml).toMatchObject({ version: 2 })
      expect(cell.metadata?.aquillaImport).toMatchObject({
        profileId: REACH4LIFE_PROFILE_ID,
        profileVersion: "1",
        fidelity: "content-only",
        sourceLocator: { kind: "idml" },
      })
    }
  })

  it("plans navigation milestones from the section each cell belongs to", async () => {
    const requests = captureRequests()

    await importBiblicaStudyNotes(await reach4LifeFile(), ctx, undefined, { edition: "reach4life" })

    const cells = importBodies(requests).flatMap((body) => body.cells ?? [])
    const milestoneOf = (value: string) => (
      (cells.find((cell) => cell.value === value)?.metadata?.aquillaImport as {
        milestone?: { key?: string; kind?: string; label?: string; shortLabel?: string }
      })?.milestone
    )

    expect(milestoneOf(SAMPLE_REACH4LIFE.bookIntroBody)).toEqual({
      key: "reach4life:book:MAT",
      kind: "preface",
      label: "Matthew introduction",
      shortLabel: "MAT",
    })
    expect(milestoneOf(SAMPLE_REACH4LIFE.secondBookIntroHead)).toMatchObject({
      key: "reach4life:book:MRK",
      label: "Mark introduction",
    })
    expect(milestoneOf(SAMPLE_REACH4LIFE.copyright)).toEqual({
      key: "reach4life:section:copyright",
      kind: "section",
      label: "Copyright",
      shortLabel: "1",
    })
    expect(milestoneOf(SAMPLE_REACH4LIFE.readingGuide)).toMatchObject({
      key: "reach4life:section:intros",
      label: "Introduction",
    })
  })

  it("commits a lesson block as one cell when sentence splitting is off", async () => {
    const requests = captureRequests()

    await importBiblicaStudyNotes(
      await reach4LifeFile(reach4LifeWorkbookSampleStory),
      ctx,
      undefined,
      { edition: "reach4life", splitSentences: false },
    )

    const cells = importBodies(requests).flatMap((body) => body.cells ?? [])
    expect(cells.map((cell) => cell.value)).toContain(SAMPLE_REACH4LIFE.lessonBlock)
    expect(cells).toHaveLength(7)
    expect(cells.find((cell) => (
      cell.value === SAMPLE_REACH4LIFE.lessonBlock
    ))?.metadata?.idmlRejoin).toBeUndefined()
  })

  it("commits the sentences of a lesson block as distinct cells that can be rejoined", async () => {
    const requests = captureRequests()

    await importBiblicaStudyNotes(
      await reach4LifeFile(reach4LifeWorkbookSampleStory),
      ctx,
      undefined,
      { edition: "reach4life" },
    )

    const cells = importBodies(requests).flatMap((body) => body.cells ?? [])
    const sentenceCells = cells.filter((cell) => (
      (SAMPLE_REACH4LIFE.lessonBlockSentences as readonly string[]).includes(cell.value)
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

    // A Reach 4 Life package has no `intro:*` paragraphs, which is the failure
    // the toggle exists to resolve — so the message has to point at the toggle.
    await expect(importBiblicaStudyNotes(await reach4LifeFile(), ctx))
      .rejects.toThrow(/Treasure Hunt Bible, a Reach 4 Life or an EBL file/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("explains that a package with no workbook holds no Reach 4 Life content", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const scriptureOnly = await reach4LifeFile([
      scripture("p-v1", SAMPLE_REACH4LIFE.scriptureBody, { chapter: "1", verse: "1" }),
      styled("p-rh", "Page Elements:h", "Matthew"),
    ])

    await expect(importBiblicaStudyNotes(scriptureOnly, ctx, undefined, { edition: "reach4life" }))
      .rejects.toThrow(/contained no Reach 4 Life content/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects a file that is not an IDML package without creating server state", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(importBiblicaStudyNotes(
      new File(["Book\tChapter\n"], "lessons.tsv"),
      ctx,
      undefined,
      { edition: "reach4life" },
    )).rejects.toThrow(/\.idml package/)

    await expect(importBiblicaStudyNotes(
      new File(["not a zip"], "lessons.idml"),
      ctx,
      undefined,
      { edition: "reach4life" },
    )).rejects.toThrow(/not a valid IDML package/)

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("Biblica edition folders", () => {
  it("files each edition under its own corpus, so one project can hold all three", async () => {
    captureRequests()

    const studyNotes = await importBiblicaStudyNotes(
      new File([await makeBiblicaIdml()], "esv-study-notes.idml"),
      ctx,
    )
    const treasureHunt = await importBiblicaStudyNotes(
      new File([await makeTreasureHuntIdml()], "ukNIRV13_THB-01-05-Gen-Deu.idml"),
      ctx,
      undefined,
      { edition: "treasure-hunt" },
    )
    const reach4Life = await importBiblicaStudyNotes(
      await reach4LifeFile(),
      ctx,
      undefined,
      { edition: "reach4life" },
    )

    expect([studyNotes, treasureHunt, reach4Life].map((ref) => ref.corpusMarker))
      .toEqual(["Biblica Study Notes", "Treasure Hunt Bible", "Reach 4 Life"])
  })
})
