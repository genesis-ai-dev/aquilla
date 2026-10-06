// AQU-1688 — loading and compiling Bible data checks for the open file.
//
// WHY: the checks must cost nothing for a project that has not asked for them
// (no pack fetch while they are off or dormant), must compile once per file
// and pack version rather than on every keystroke, and must hand the engine
// each cell's own facts.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { loadLayer, loadManifest } from "@/lib/bible-data/pack-client"
import { useBibleChecks } from "./useBibleChecks"
import type { BibleChecksProject } from "@/lib/bible-data/check-context"
import type { BkpManifest } from "@/lib/bible-data/pack-types"
import { JHN4_STRUCTURE, JHN4_VOICES } from "../../db/shared/bible-checks/__fixtures__/pack"
import { JHN_A_STRUCTURE, JHN_A_TEXT, JHN_A_VOICES } from "../../db/shared/bible-checks/__fixtures__/pack-a"
import { JHN_B_PEOPLE, JHN_B_STRUCTURE, JHN_B_TEXT, JHN_B_VOICES } from "../../db/shared/bible-checks/__fixtures__/pack-b"

vi.mock("@/lib/bible-data/pack-client", () => ({
  loadManifest: vi.fn(),
  loadLayer: vi.fn(),
}))

const ENGLISH = {
  quoteMarks: { levels: [{ open: "“", close: "”" }], continuation: "reopen-each-paragraph" as const },
}
const scripture = [{ type: "usfm" as const }]
const ON: BibleChecksProject = { bibleResourcesEnabled: true, files: scripture, languageProfile: ENGLISH }
const CELLS = [
  { id: "c7", globalReferences: ["JHN 4:7"] },
  { id: "c9", globalReferences: ["JHN 4:9"] },
  { id: "heading", globalReferences: ["JHN 4"] },
]

beforeEach(() => {
  vi.mocked(loadManifest).mockReset().mockResolvedValue({ ok: true, value: { version: "1.0.0" } as BkpManifest })
  vi.mocked(loadLayer).mockReset().mockImplementation(async (layer) => {
    if (layer === "voices") return { ok: true, value: JHN4_VOICES } as never
    if (layer === "structure") return { ok: true, value: JHN4_STRUCTURE } as never
    return { ok: false, reason: "not-found" }
  })
})

describe("useBibleChecks", () => {
  it("loads the book's voices and structure once, and gives each verse cell its own expectation", async () => {
    const { result } = renderHook(() => useBibleChecks(ON, CELLS))
    expect(result.current.status).toBe("loading")
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(vi.mocked(loadLayer).mock.calls.map(([layer, book]) => `${layer}/${book}`).sort()).toEqual([
      "structure/JHN",
      "voices/JHN",
    ])
    expect(result.current.contextFor("c9")?.bible?.expectation.refs).toEqual(["JHN 4:9"])
    expect(result.current.contextFor("c9")?.bible?.profile).toEqual(ENGLISH)
    expect(result.current.contextFor("heading")).toBeUndefined()
    expect(result.current.signature).toMatch(/^bkp:1\.0\.0\|JHN\|/)
  })

  it("keeps the same compile when only cell text changes, and recompiles when refs change", async () => {
    let cells = CELLS
    const { result, rerender } = renderHook(() => useBibleChecks(ON, cells))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    const { signature, contextFor } = result.current
    cells = CELLS.map((cell) => ({ ...cell, translated: "typing…" }))
    rerender()
    expect(result.current.signature).toBe(signature)
    expect(result.current.contextFor).toBe(contextFor)
    cells = [...CELLS, { id: "c10", globalReferences: ["JHN 4:10"] }]
    rerender()
    expect(result.current.signature).not.toBe(signature)
    expect(result.current.contextFor("c10")).toBeDefined()
  })

  it("fetches nothing while the checks are off or dormant", () => {
    const off = renderHook(() => useBibleChecks({ ...ON, bibleEnrichments: { checks: false } }, CELLS))
    expect(off.result.current.status).toBe("off")
    const dormant = renderHook(() => useBibleChecks({ ...ON, languageProfile: {} }, CELLS))
    expect(dormant.result.current.status).toBe("dormant")
    expect(dormant.result.current.contextFor("c9")).toBeUndefined()
    expect(loadLayer).not.toHaveBeenCalled()
    expect(loadManifest).not.toHaveBeenCalled()
  })

  it("is unavailable for a file with no verse refs, or when the pack lacks the book", async () => {
    expect(renderHook(() => useBibleChecks(ON, [{ id: "h", globalReferences: ["JHN 4"] }])).result.current.status).toBe(
      "unavailable",
    )
    vi.mocked(loadLayer).mockResolvedValue({ ok: false, reason: "not-found" })
    const { result } = renderHook(() => useBibleChecks(ON, CELLS))
    await waitFor(() => expect(result.current.status).toBe("unavailable"))
    expect(result.current.contextFor("c9")).toBeUndefined()
  })

  // AQU-1697: the text layer is several MB per book. WHY: it must load only
  // while a check that reads it can run, and Check file's scans must work
  // even while every live check waits for the Language profile.
  it("loads the text layer only for a check that reads it, and compiles its facts", async () => {
    vi.mocked(loadLayer).mockImplementation(async (layer) => {
      if (layer === "voices") return { ok: true, value: JHN_A_VOICES } as never
      if (layer === "structure") return { ok: true, value: JHN_A_STRUCTURE } as never
      return { ok: true, value: JHN_A_TEXT } as never
    })
    const cells = [{ id: "c11", globalReferences: ["JHN 21:11"] }]
    const quotes = renderHook(() => useBibleChecks(ON, cells))
    await waitFor(() => expect(quotes.result.current.status).toBe("ready"))
    expect(vi.mocked(loadLayer).mock.calls.some(([layer]) => layer === "text")).toBe(false)
    expect(quotes.result.current.contextFor("c11")?.bible?.expectation.numbers).toEqual([])

    const numbers = renderHook(() => useBibleChecks({ ...ON, languageProfile: { numberWords: "cldr" } }, cells))
    await waitFor(() => expect(numbers.result.current.contextFor("c11")?.bible?.expectation.numbers).toHaveLength(1))
    expect(vi.mocked(loadLayer).mock.calls.some(([layer]) => layer === "text")).toBe(true)
    expect(numbers.result.current.contextFor("c11")?.bible?.expectation.numbers[0]?.value).toBe(153)
  })

  it("loads the structure layer for Check file's scans, even while the live checks are dormant", async () => {
    const headingsOnly = { ...ON, languageProfile: { headings: "pericope" as const } }
    const { result } = renderHook(() => useBibleChecks(headingsOnly, CELLS))
    expect(result.current.status).toBe("dormant")
    expect(loadLayer).not.toHaveBeenCalled()
    const scan = await result.current.fileScan()
    expect(scan?.profile).toEqual({ headings: "pericope" })
    expect(scan?.structure).toBe(JHN4_STRUCTURE)
    // AQU-1699: X3 compares the Greek of repeated quotations, so Check file reads voices and text too.
    expect(vi.mocked(loadLayer).mock.calls.map(([layer]) => layer)).toEqual(["structure", "voices", "text"])
    expect(scan?.voices).toBe(JHN4_VOICES)
    const off = renderHook(() => useBibleChecks({ ...ON, bibleEnrichments: { checks: false } }, CELLS))
    expect(await off.result.current.fileScan()).toBeNull()
  })

  // AQU-1699: check pack B reads who each word refers to. WHY: the people
  // layer must load only while a participant check can run, which takes the
  // project's decisions or terminology, and each cell must get the agreed
  // names those give.
  it("loads the people layer only once a decision or terminology entry names someone", async () => {
    vi.mocked(loadLayer).mockImplementation(async (layer) => {
      if (layer === "voices") return { ok: true, value: JHN_B_VOICES } as never
      if (layer === "structure") return { ok: true, value: JHN_B_STRUCTURE } as never
      if (layer === "people") return { ok: true, value: JHN_B_PEOPLE } as never
      return { ok: true, value: JHN_B_TEXT } as never
    })
    const cells = [{ id: "c42", globalReferences: ["JHN 1:42"] }]
    const plain = renderHook(() => useBibleChecks(ON, cells))
    await waitFor(() => expect(plain.result.current.status).toBe("ready"))
    expect(vi.mocked(loadLayer).mock.calls.some(([layer]) => layer === "people")).toBe(false)
    expect(plain.result.current.contextFor("c42")?.bible?.expectation.participants).toBeNull()

    const decided = { ...ON, sourceLanguage: "en", projectFacts: [renderPeter] }
    const named = renderHook(() => useBibleChecks(decided, cells))
    await waitFor(() => expect(named.result.current.contextFor("c42")?.bible?.expectation.participants).toBeTruthy())
    expect(vi.mocked(loadLayer).mock.calls.some(([layer]) => layer === "people")).toBe(true)
    const participants = named.result.current.contextFor("c42")?.bible?.expectation.participants
    expect(participants?.named.map((m) => m.entity)).toContain("person:Peter")
    expect(participants?.names.names.get("person:Peter")?.[0]).toMatchObject({ renderings: ["Peter", "Cephas"], source: "fact" })

    // A terminology entry for the label in the source language names someone too.
    const termed = renderHook(() =>
      useBibleChecks({ ...ON, sourceLanguage: "en" }, cells, [
        { id: "k1", sourceTerm: "Andrew", status: "active", renderings: [{ rendering: "Andrés", status: "preferred" }] },
      ]),
    )
    await waitFor(() => expect(termed.result.current.contextFor("c42")?.bible?.expectation.participants).toBeTruthy())
    expect(termed.result.current.contextFor("c42")?.bible?.expectation.participants?.names.names.get("person:Andrew")?.[0]).toMatchObject({
      renderings: ["Andrés"],
      source: "terminology",
    })
  })
})

const renderPeter = {
  id: "f1",
  key: "render.person.Peter",
  value: "Peter|Cephas",
  scope: {},
  author: "dev",
  at: "2026-10-06T00:00:00.000Z",
}
