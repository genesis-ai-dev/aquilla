/**
 * AQU-1694 — "Align source text to Greek" in the Who's Who panel.
 *
 * Through the real panel, the real alignment (inline: no Worker in tests),
 * and a stubbed sync-worker that keeps what was posted. What it protects:
 *   • a maintainer on an English source can align the book, and the panel
 *     then says how much is aligned and what dotted highlights mean;
 *   • the run sends the links of the text the server has, hashed, starting a
 *     new run for the file, and the trained size that makes a short book dotted;
 *   • a run can be cancelled before anything is saved;
 *   • verses edited since the alignment are counted, and a refused save says why;
 *   • someone who may not align sees who can, and a Greek source needs nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { WhosWhoSidebar } from "./WhosWhoSidebar"
import { __resetSourceAlignmentStore } from "./source-alignment-store"
import { bridgeJhn4, bridgeJhn4Text } from "@/lib/bible-data/__fixtures__/bridge-jhn4"
import { JHN4_PEOPLE_JSON, JHN4_STRUCTURE_JSON } from "@/lib/bible-data/__fixtures__/jhn4"
import { __resetBkpMemoryCache } from "@/lib/bible-data/pack-client"
import { __clearPackStore } from "@/lib/bible-data/pack-store"
import { contentHash } from "@/lib/dcs/content-hash"
import type { ProjectRecord } from "@/lib/parsers/types"
import { resetBibleDataViewPrefsCacheForTests } from "@/lib/store/bible-data-view-prefs"

const FILE_ID = "file-jhn"
const VERSES = bridgeJhn4()
const MANIFEST = {
  pack: "bkp",
  version: "1.0.0",
  builtAt: "2026-10-06T03:39:26.174Z",
  versification: "org",
  sources: [],
  layers: {},
  books: { JHN: { layers: ["text", "structure", "voices", "people"], bytes: {} } },
}
const FILES: Readonly<Record<string, string>> = {
  "/people/JHN.json": JHN4_PEOPLE_JSON,
  // All of John 4's Greek words, so the whole chapter can be aligned.
  "/text/JHN.json": JSON.stringify(bridgeJhn4Text(VERSES)),
  "/structure/JHN.json": JHN4_STRUCTURE_JSON,
}

interface PostedCell {
  cellId: string
  sourceHash: string
  links: [string, number, number][]
}
interface PostedBody {
  replace: "file" | "cells"
  method: string
  trainedPairs: number
  cells: PostedCell[]
}

let posted: PostedBody[] = []
let saveStatus = 200
let staleCellIds: string[] = []
let releaseCells: (() => void) | null = null
let holdCells = false

const sourceRows = () =>
  VERSES.map((verse) => ({
    cellId: `cell-${verse.ref}`,
    side: "source",
    value: verse.bsb,
    valueHtml: null,
    type: "text",
    canonicalRef: verse.ref,
    anchorCellId: null,
    eventId: `ev-${verse.ref}`,
    sourceEventId: null,
    lastEditor: null,
    lastEditAt: 1,
    validated: false,
    wordCount: 1,
  }))

const fetchMock = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
  const path = new URL(input).pathname
  if (path.endsWith("/source-word-alignment")) {
    if (init?.method === "POST") {
      if (saveStatus !== 200) return new Response("nope", { status: saveStatus })
      const body = JSON.parse(String(init.body)) as PostedBody
      posted.push(body)
      return Response.json({ accepted: body.cells.length, links: 0, stale: [] })
    }
    const cells = posted.flatMap((body) =>
      body.cells.map((cell) => ({
        ...cell,
        method: body.method,
        trainedPairs: body.trainedPairs,
        stale: staleCellIds.includes(cell.cellId),
        links: staleCellIds.includes(cell.cellId) ? [] : cell.links,
      })),
    )
    return Response.json({ cells })
  }
  if (path.endsWith(`/files/${FILE_ID}/cells`)) {
    if (holdCells) await new Promise<void>((resolve) => (releaseCells = resolve))
    return Response.json({ cells: sourceRows(), nextCursor: null, total: VERSES.length })
  }
  if (path.endsWith("/manifest.json")) return Response.json(MANIFEST)
  const file = Object.entries(FILES).find(([suffix]) => path.endsWith(suffix))
  return file ? new Response(file[1], { status: 200 }) : new Response("missing", { status: 404 })
})

function renderPanel({ role = 600, sourceLanguage = "en" }: { role?: number; sourceLanguage?: string } = {}) {
  const project: ProjectRecord = {
    id: "proj-1",
    name: "Injil Yohanes",
    sourceLanguage,
    targetLanguage: "id",
    createdAt: "2026-01-01T00:00:00Z",
    files: [{ id: FILE_ID, name: "JHN", type: "usfm" } as ProjectRecord["files"][number]],
    members: [],
    syncRole: { level: role, name: "maintainer", source: "direct", fetchedAt: "2026-10-06T00:00:00Z" },
  } as ProjectRecord
  render(
    <WhosWhoSidebar
      project={project}
      fileId={FILE_ID}
      trackedRef="JHN 4:7"
      sourceLanguage={sourceLanguage}
      getTokenForFile={async () => "jwt"}
      open
      onToggle={() => {}}
    />,
  )
}

// A stall watchdog, not a speed bar (AGENTS.md rule 15): a run reads, aligns
// and saves 54 verses, which can take seconds on a busy machine.
const LOAD = { timeout: 10_000 }
const alignButton = () => screen.findByRole("button", { name: "Align source text to Greek" }, LOAD)

beforeEach(async () => {
  localStorage.clear()
  resetBibleDataViewPrefsCacheForTests()
  __resetSourceAlignmentStore()
  posted = []
  saveStatus = 200
  staleCellIds = []
  holdCells = false
  releaseCells = null
  fetchMock.mockClear()
  vi.stubGlobal("fetch", fetchMock)
  __resetBkpMemoryCache()
  await __clearPackStore()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("a maintainer aligns the book", () => {
  it("aligns the source text and then says how much of the book is aligned", async () => {
    renderPanel()
    fireEvent.click(await alignButton())
    await waitFor(
      () =>
        expect(screen.getByTestId("whos-who-alignment-status").textContent).toBe(
          "54 verses of this book are aligned to the Greek.",
        ),
      LOAD,
    )
    // 54 verses is a short book: every highlight is dotted, and the panel says why.
    expect(screen.getByTestId("whos-who-alignment").textContent).toContain("fewer than 120 verses")
    expect(screen.getByRole("button", { name: "Align again" })).toBeTruthy()
  })

  it("saves links for the text the server has, as one new run for the file", async () => {
    renderPanel()
    fireEvent.click(await alignButton())
    await waitFor(() => expect(posted.length).toBe(1), LOAD)
    const [body] = posted
    expect(body).toMatchObject({ replace: "file", method: "ibm1-gdfa-names/1", trainedPairs: 54 })
    const verse7 = body.cells.find((cell) => cell.cellId === "cell-JHN 4:7")!
    const bsb7 = VERSES.find((verse) => verse.ref === "JHN 4:7")!.bsb
    // The server refuses links whose hash is not the source row's content_hash.
    expect(verse7.sourceHash).toBe(contentHash(bsb7))
    // αὐτῇ reaches "her" (token 11 of the BSB verse).
    expect(verse7.links).toContainEqual(["n43004007009", 11, expect.any(Number)])
  })

  it("can be cancelled before anything is saved", async () => {
    holdCells = true
    renderPanel()
    fireEvent.click(await alignButton())
    expect(await screen.findByText("Reading the source text…", {}, LOAD)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    releaseCells?.()
    expect(await alignButton()).toBeTruthy()
    expect(posted).toEqual([])
  })

  it("counts the verses edited since the alignment", async () => {
    renderPanel()
    fireEvent.click(await alignButton())
    await waitFor(() => expect(posted.length).toBe(1), LOAD)
    staleCellIds = ["cell-JHN 4:7", "cell-JHN 4:9"]
    __resetSourceAlignmentStore()
    renderPanel()
    expect((await screen.findAllByTestId("whos-who-alignment-stale", {}, LOAD)).at(-1)!.textContent).toBe(
      "2 verses changed after they were aligned. Their words have no highlights until you align again.",
    )
  })

  it("says why when the server refuses the save, and offers to try again", async () => {
    saveStatus = 403
    renderPanel()
    fireEvent.click(await alignButton())
    expect((await screen.findByRole("alert", {}, LOAD)).textContent).toBe("Only a project maintainer can align the source text.")
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy()
  })
})

describe("who sees what", () => {
  it("tells someone who may not align who can, with no button", async () => {
    renderPanel({ role: 500 })
    expect((await screen.findByTestId("whos-who-alignment-note", {}, LOAD)).textContent).toContain("need an alignment")
    expect(screen.getByTestId("whos-who-alignment").textContent).toContain("A project maintainer can align")
    expect(screen.queryByRole("button", { name: "Align source text to Greek" })).toBeNull()
  })

  it("shows nothing about alignment on a Greek source", async () => {
    renderPanel({ sourceLanguage: "grc" })
    await screen.findByTestId("whos-who-passage", {}, LOAD)
    expect(screen.queryByTestId("whos-who-alignment")).toBeNull()
  })
})
