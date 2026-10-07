// Original-language morphology read. (AQU-462)
//
// Word order is not cosmetic here: the alignment adapter maps word N of the
// cell onto token N of the verse, so a response that arrives (or is merged)
// out of order would attach one word's lemma and Strong's number to another
// word's rendering — a wrong claim about the text, silently.

import { describe, it, expect, vi, afterEach } from "vitest"
import { fetchCellMorph, indexMorphByCell, MorphReadError, type MorphWord } from "./morph-read"

const word = (cellId: string, wordSeq: number, surface: string): MorphWord => ({
  cellId,
  wordSeq,
  surface,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("indexMorphByCell", () => {
  it("groups words by cell and orders each cell by wordSeq", () => {
    const index = indexMorphByCell([
      word("c1", 3, "אֱלֹהִים"),
      word("c2", 1, "וְהָאָרֶץ"),
      word("c1", 1, "בְּרֵאשִׁית"),
      word("c1", 2, "בָּרָא"),
    ])

    expect([...index.keys()].sort()).toEqual(["c1", "c2"])
    expect(index.get("c1")!.map((w) => w.surface)).toEqual(["בְּרֵאשִׁית", "בָּרָא", "אֱלֹהִים"])
    expect(index.get("c2")!.map((w) => w.wordSeq)).toEqual([1])
  })

  it("is empty for no words", () => {
    expect(indexMorphByCell([]).size).toBe(0)
  })
})

describe("fetchCellMorph", () => {
  it("never reaches the network for an empty ask", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    expect(await fetchCellMorph({ projectId: "p", fileId: "f", cellIds: [], jwt: "t" })).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("sends the cell ids and the sync token, and returns the words", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ words: [word("c1", 1, "λογος")] }), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    const words = await fetchCellMorph({
      projectId: "p 1",
      fileId: "f/1",
      cellIds: ["c1", "c2"],
      jwt: "tok",
    })

    expect(words).toEqual([word("c1", 1, "λογος")])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain("/projects/p%201/files/f%2F1/morph")
    expect(url).toContain("cellIds=c1%2Cc2")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok")
  })

  it("raises a typed error carrying the status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })))

    await expect(
      fetchCellMorph({ projectId: "p", fileId: "f", cellIds: ["c1"], jwt: "tok" }),
    ).rejects.toBeInstanceOf(MorphReadError)
  })

  it("treats a response without a words array as no morphology", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })))

    expect(await fetchCellMorph({ projectId: "p", fileId: "f", cellIds: ["c1"], jwt: "t" })).toEqual([])
  })
})
