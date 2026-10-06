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
})
