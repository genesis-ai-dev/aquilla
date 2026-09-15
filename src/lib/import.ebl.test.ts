import { afterEach, describe, expect, it, vi } from "vitest"
import { SAMPLE_EBL, makeEblIdml, styled } from "./biblica/ebl/__fixtures__/ebl-idml"
import type { EblIdmlStories } from "./biblica/ebl/__fixtures__/ebl-idml"

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

const { importBiblicaStudyNotes, EBL_PROFILE_ID } = await import("./import")

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

async function eblFile(
  stories: EblIdmlStories = {},
  name = "ukEng_MODULE 1_EBL_FACILITATOR GUIDE.idml",
): Promise<File> {
  return new File([await makeEblIdml(stories)], name, {
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

/** The milestone the import planner persisted on a committed cell. */
function milestoneOf(
  cells: Array<{ value: string; metadata?: Record<string, unknown> }>,
  value: string,
) {
  return (cells.find((cell) => cell.value === value)?.metadata?.aquillaImport as {
    milestone?: { key?: string; kind?: string; label?: string; shortLabel?: string }
  })?.milestone
}

describe("EBL import", () => {
  it("commits the whole guide, preserving the package as the source artifact", async () => {
    const requests = captureRequests()
    const file = await eblFile()
    const originalBytes = new Uint8Array(await file.arrayBuffer())

    const ref = await importBiblicaStudyNotes(file, ctx, undefined, { edition: "ebl" })

    expect(ref.type).toBe("idml")

    const bodies = importBodies(requests)
    expect(bodies.find((body) => body.file)?.file).toMatchObject({
      fileType: "idml",
      kind: "idml",
      parserVersion: `${EBL_PROFILE_ID}@1`,
      corpusMarker: "Equipping Biblical Leaders",
    })
    // A guide is about no single book, however much scripture it teaches.
    expect(bodies.find((body) => body.file)?.file?.bookCode).toBeUndefined()

    const cells = bodies.flatMap((body) => body.cells ?? [])
    expect(ref.cellCount).toBe(cells.length)
    // Nothing is dropped for being scripture, and a line-broken contents block
    // is committed one cell per line.
    const values = cells.map((cell) => cell.value)
    expect(values).toContain(SAMPLE_EBL.bibleStudyBody)
    for (const entry of SAMPLE_EBL.contentsEntries) expect(values).toContain(entry)
    expect(values).toContain(SAMPLE_EBL.writeInPrompt)
    expect(values).not.toContain(SAMPLE_EBL.tableNumber)
    expect(values).not.toContain(SAMPLE_EBL.writeInRule)

    // Whole-package bytes are preserved under the IDML artifact format, so a
    // strict round-trip export still has the original to write back into.
    const sourceUpload = requests.find((request) => request.url.includes("/source"))
    expect(sourceUpload?.init?.headers).toMatchObject({ "X-Source-Format": "idml" })
    expect(new Uint8Array(sourceUpload?.init?.body as ArrayBuffer)).toEqual(originalBytes)

    expect(bodies.some((body) => body.complete && typeof body.publishEventId === "string")).toBe(true)
  })

  it("plans navigation milestones from the guide's own topic and lesson headings", async () => {
    const requests = captureRequests()

    await importBiblicaStudyNotes(await eblFile(), ctx, undefined, { edition: "ebl" })

    const cells = importBodies(requests).flatMap((body) => body.cells ?? [])

    expect(milestoneOf(cells, SAMPLE_EBL.introBody)).toEqual({
      key: "ebl:section:2:introduction",
      kind: "section",
      label: SAMPLE_EBL.introHead,
      shortLabel: "2",
    })
    expect(milestoneOf(cells, SAMPLE_EBL.moduleBody)).toMatchObject({
      // A two-line heading names its division from both halves.
      label: "MODULE 1 How we have the Bible",
    })
    expect(milestoneOf(cells, SAMPLE_EBL.topicBody)).toEqual({
      key: "ebl:topic:1.1",
      kind: "section",
      label: "Topic 1.1: How God shows himself",
      shortLabel: "1.1",
    })
    expect(milestoneOf(cells, SAMPLE_EBL.bibleStudyBody)).toEqual({
      key: "ebl:lesson:1.1:1",
      kind: "section",
      label: "Lesson 1: Seeing God from a distance",
      shortLabel: "1.1.1",
    })
    expect(milestoneOf(cells, SAMPLE_EBL.lessonTwoBody)).toMatchObject({
      key: "ebl:lesson:1.1:2",
      label: "Lesson 2: Seeing God up close",
    })
  })

  it("gives every committed cell a milestone, each owning one unbroken run", async () => {
    const requests = captureRequests()

    await importBiblicaStudyNotes(await eblFile(), ctx, undefined, { edition: "ebl" })

    const cells = importBodies(requests).flatMap((body) => body.cells ?? [])
    const keys = cells.map((cell) => milestoneOf(cells, cell.value)?.key)
    expect(keys.every(Boolean)).toBe(true)

    // The navigator groups by key, so a division split across two runs would
    // page as two disjoint ranges of the file.
    const runs = keys.filter((key, index) => key !== keys[index - 1])
    expect(new Set(runs).size).toBe(runs.length)
    // The loose frames the package lists ahead of the guide, then the outline.
    expect(runs[0]).toBe("ebl:boxes:1")
    expect(runs.at(-1)).toBe("ebl:section:5:words-you-need-to-know-list")
  })

  it("does not let a lesson's timing badge open a division of its own", async () => {
    const requests = captureRequests()

    await importBiblicaStudyNotes(await eblFile(), ctx, undefined, { edition: "ebl" })

    const cells = importBodies(requests).flatMap((body) => body.cells ?? [])
    // Set in the same level-1 style a lesson tag uses, but a frame of its own.
    expect(milestoneOf(cells, SAMPLE_EBL.timingBadge)).toMatchObject({
      key: "ebl:boxes:1",
      label: "Boxes and tables",
    })
    const labels = cells.map((cell) => milestoneOf(cells, cell.value)?.label)
    expect(labels).not.toContain(SAMPLE_EBL.timingBadge)
  })

  it("carries each cell's division, edition and locator into the committed metadata", async () => {
    const requests = captureRequests()

    await importBiblicaStudyNotes(await eblFile(), ctx, undefined, { edition: "ebl" })

    const cells = importBodies(requests).flatMap((body) => body.cells ?? [])
    expect(cells.find((cell) => cell.value === SAMPLE_EBL.bibleStudyBody)?.metadata?.biblica)
      .toMatchObject({
        edition: "ebl",
        contentType: "lesson",
        sectionId: "ebl:lesson:1.1:1",
        sectionLabel: "Lesson 1: Seeing God from a distance",
      })
    for (const cell of cells) {
      expect(cell.metadata?.biblica).toMatchObject({ edition: "ebl" })
      expect(cell.metadata?.idml).toMatchObject({ version: 2 })
      expect(cell.metadata?.aquillaImport).toMatchObject({
        profileId: EBL_PROFILE_ID,
        profileVersion: "1",
        fidelity: "content-only",
        sourceLocator: { kind: "idml" },
      })
    }
  })

  it("commits a teaching block as one cell when sentence splitting is off", async () => {
    const requests = captureRequests()

    await importBiblicaStudyNotes(await eblFile(), ctx, undefined, {
      edition: "ebl",
      splitSentences: false,
    })

    const cells = importBodies(requests).flatMap((body) => body.cells ?? [])
    expect(cells.map((cell) => cell.value)).toContain(SAMPLE_EBL.lessonBlock)
    expect(cells.find((cell) => (
      cell.value === SAMPLE_EBL.lessonBlock
    ))?.metadata?.idmlRejoin).toBeUndefined()
  })

  it("commits the sentences of a block as distinct cells that can be rejoined", async () => {
    const requests = captureRequests()

    await importBiblicaStudyNotes(await eblFile(), ctx, undefined, {
      edition: "ebl",
      splitSentences: true,
    })

    const cells = importBodies(requests).flatMap((body) => body.cells ?? [])
    const sentenceCells = cells.filter((cell) => (
      (SAMPLE_EBL.lessonBlockSentences as readonly string[]).includes(cell.value)
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

  it("files the guide under its own corpus, apart from the other Biblica titles", async () => {
    captureRequests()

    const ref = await importBiblicaStudyNotes(await eblFile(), ctx, undefined, { edition: "ebl" })

    expect(ref.corpusMarker).toBe("Equipping Biblical Leaders")
  })

  it("reads the same package as the study-Bible importer would when the toggle is off", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    // An EBL guide has no `intro:*` paragraphs, which is the failure the toggle
    // exists to resolve — so the message has to point at the toggle.
    await expect(importBiblicaStudyNotes(await eblFile(), ctx))
      .rejects.toThrow(/a Reach 4 Life or an EBL file/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("explains that a package with no text holds nothing to import", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const artworkOnly = await eblFile({
      body: [styled("f-page", "*Page number", "12")],
      badge: [],
      summary: [],
    })

    await expect(importBiblicaStudyNotes(artworkOnly, ctx, undefined, { edition: "ebl" }))
      .rejects.toThrow(/contained no text/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects a file that is not an IDML package without creating server state", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(importBiblicaStudyNotes(
      new File(["Topic\tLesson\n"], "guide.tsv"),
      ctx,
      undefined,
      { edition: "ebl" },
    )).rejects.toThrow(/\.idml package/)

    await expect(importBiblicaStudyNotes(
      new File(["not a zip"], "guide.idml"),
      ctx,
      undefined,
      { edition: "ebl" },
    )).rejects.toThrow(/not a valid IDML package/)

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
