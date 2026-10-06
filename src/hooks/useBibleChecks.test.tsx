// AQU-1688 — loading and compiling Bible data checks for the open file.
//
// WHY: the checks must cost nothing for a project that has not asked for them
// (no pack fetch while they are off or dormant), must compile once per file
// and pack version rather than on every keystroke, and must hand the engine
// each cell's own facts. AQU-1685: they are part of the Bible data
// experiment, so they also cost and show nothing on a device that has not
// switched it on, or while the open file is not a Bible book.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { loadLayer, loadManifest } from "@/lib/bible-data/pack-client"
import { useBibleChecks } from "./useBibleChecks"
import type { BibleChecksProject } from "@/lib/bible-data/check-context"
import type { BkpManifest } from "@/lib/bible-data/pack-types"
import { JHN4_STRUCTURE, JHN4_VOICES } from "../../db/shared/bible-checks/__fixtures__/pack"
import { JHN_A_STRUCTURE, JHN_A_TEXT, JHN_A_VOICES } from "../../db/shared/bible-checks/__fixtures__/pack-a"

vi.mock("@/lib/bible-data/pack-client", () => ({
  loadManifest: vi.fn(),
  loadLayer: vi.fn(),
}))

const ENGLISH = {
  quoteMarks: { levels: [{ open: "“", close: "”" }], continuation: "reopen-each-paragraph" as const },
}
const scripture = [{ type: "usfm" as const }]
const BOOK = scripture[0]
const ON: BibleChecksProject = {
  bibleResourcesEnabled: true,
  files: scripture,
  languageProfile: ENGLISH,
  experimentalFlags: { bibleData: true },
}
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
    const { result } = renderHook(() => useBibleChecks(ON, CELLS, BOOK))
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
    const { result, rerender } = renderHook(() => useBibleChecks(ON, cells, BOOK))
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
    const off = renderHook(() => useBibleChecks({ ...ON, bibleEnrichments: { checks: false } }, CELLS, BOOK))
    expect(off.result.current.status).toBe("off")
    const dormant = renderHook(() => useBibleChecks({ ...ON, languageProfile: {} }, CELLS, BOOK))
    expect(dormant.result.current.status).toBe("dormant")
    expect(dormant.result.current.contextFor("c9")).toBeUndefined()
    expect(loadLayer).not.toHaveBeenCalled()
    expect(loadManifest).not.toHaveBeenCalled()
  })

  // The experiment is device-local and off by default: a collaborator who
  // switched it on must not make Bible data checks fetch or flag anything here.
  it("is off, and fetches nothing, while this device has the Bible data experiment off", () => {
    const { result } = renderHook(() => useBibleChecks({ ...ON, experimentalFlags: {} }, CELLS, BOOK))
    expect(result.current.status).toBe("off")
    expect(result.current.contextFor("c9")).toBeUndefined()
    expect(loadLayer).not.toHaveBeenCalled()
    expect(loadManifest).not.toHaveBeenCalled()
  })

  // "A Bible is open" for checks: the open file has scripture sections. A
  // non-scripture file whose cells happen to carry verse refs gets nothing.
  it("is off, and fetches nothing, unless the open file is a Bible book", () => {
    const notes = renderHook(() => useBibleChecks(ON, CELLS, { type: "md" }))
    expect(notes.result.current.status).toBe("off")
    expect(notes.result.current.contextFor("c9")).toBeUndefined()
    const none = renderHook(() => useBibleChecks(ON, CELLS, null))
    expect(none.result.current.status).toBe("off")
    expect(loadLayer).not.toHaveBeenCalled()
    expect(loadManifest).not.toHaveBeenCalled()
  })

  it("is unavailable for a file with no verse refs, or when the pack lacks the book", async () => {
    expect(renderHook(() => useBibleChecks(ON, [{ id: "h", globalReferences: ["JHN 4"] }], BOOK)).result.current.status).toBe(
      "unavailable",
    )
    vi.mocked(loadLayer).mockResolvedValue({ ok: false, reason: "not-found" })
    const { result } = renderHook(() => useBibleChecks(ON, CELLS, BOOK))
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
    const quotes = renderHook(() => useBibleChecks(ON, cells, BOOK))
    await waitFor(() => expect(quotes.result.current.status).toBe("ready"))
    expect(vi.mocked(loadLayer).mock.calls.some(([layer]) => layer === "text")).toBe(false)
    expect(quotes.result.current.contextFor("c11")?.bible?.expectation.numbers).toEqual([])

    const numbers = renderHook(() => useBibleChecks({ ...ON, languageProfile: { numberWords: "cldr" } }, cells, BOOK))
    await waitFor(() => expect(numbers.result.current.contextFor("c11")?.bible?.expectation.numbers).toHaveLength(1))
    expect(vi.mocked(loadLayer).mock.calls.some(([layer]) => layer === "text")).toBe(true)
    expect(numbers.result.current.contextFor("c11")?.bible?.expectation.numbers[0]?.value).toBe(153)
  })

  it("loads the structure layer for Check file's scans, even while the live checks are dormant", async () => {
    const headingsOnly = { ...ON, languageProfile: { headings: "pericope" as const } }
    const { result } = renderHook(() => useBibleChecks(headingsOnly, CELLS, BOOK))
    expect(result.current.status).toBe("dormant")
    expect(loadLayer).not.toHaveBeenCalled()
    const scan = await result.current.fileScan()
    expect(scan?.profile).toEqual({ headings: "pericope" })
    expect(scan?.structure).toBe(JHN4_STRUCTURE)
    expect(vi.mocked(loadLayer).mock.calls.map(([layer]) => layer)).toEqual(["structure"])
    const off = renderHook(() => useBibleChecks({ ...ON, bibleEnrichments: { checks: false } }, CELLS, BOOK))
    expect(await off.result.current.fileScan()).toBeNull()
    // AQU-1685: nor without the Bible data experiment, or on a file that is
    // not a Bible book: Check file then runs no Bible data scan at all.
    const noExperiment = renderHook(() => useBibleChecks({ ...headingsOnly, experimentalFlags: {} }, CELLS, BOOK))
    expect(await noExperiment.result.current.fileScan()).toBeNull()
    const notABible = renderHook(() => useBibleChecks(headingsOnly, CELLS, { type: "md" }))
    expect(await notABible.result.current.fileScan()).toBeNull()
    expect(vi.mocked(loadLayer).mock.calls.map(([layer]) => layer)).toEqual(["structure"])
  })
})
