// AQU-1657 — the harmonizer reaches the editor through the smart-edits
// passage request. What matters on the client:
//   - both sources land in ONE store write per passage. Two writes would let
//     whichever answered second wipe the other's underlines for the same cells.
//   - a failed or malformed harmonizer response costs the translator nothing:
//     smart edits still show.
//   - with the flag off, no harmonizer request is made at all.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt-test" } }),
}))

import { useSmartEditsPassage } from "@/hooks/useSmartEdits"
import { fetchHarmonizerSuggestions, HARMONIZE_PASSAGE_URL } from "./client"
import { SMART_EDITS_SUGGEST_URL } from "@/lib/smart-edits/client"

const CELLS = {
  "JHN 6:26": { fileId: "JHN", cellId: "JHN 6:26", source: "εἶπεν·", target: "Jesus answered them, “Truly…", ref: "JHN 6:26" },
  "JHN 6:27": { fileId: "JHN", cellId: "JHN 6:27", source: "ἐσφράγισεν ὁ θεός.", target: "has set his seal.", ref: "JHN 6:27" },
} as const

const HARMONY = {
  fileId: "JHN", cellId: "JHN 6:27", start: 12, end: 17, old: "seal.", new: "seal.”", confidence: 0.9,
  reasonKey: "harmonizer.quotes.closeHere", reasonValues: { openedIn: "JHN 6:26" }, checkId: "textual.quotation",
}

function stub(routes: Record<string, () => Promise<unknown>>) {
  const fetchMock = vi.fn((url: string) => {
    const handler = routes[url]
    if (!handler) return Promise.reject(new Error(`unexpected ${url}`))
    return handler().then((body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) }))
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function render(harmonizerEnabled: boolean) {
  return renderHook(() =>
    useSmartEditsPassage({
      enabled: true,
      llmEnabled: false,
      harmonizerEnabled,
      projectId: "p1",
      lane: "",
      cellIds: Object.keys(CELLS),
      activeCellId: "JHN 6:27",
      activeText: CELLS["JHN 6:27"].target,
      getCell: (id) => CELLS[id as keyof typeof CELLS] ?? null,
    }),
  )
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("harmonizer in the smart-edits passage", () => {
  it("puts harmonizer and smart-edit suggestions in the store together", async () => {
    stub({
      [SMART_EDITS_SUGGEST_URL]: async () => ({ suggestions: [] }),
      [HARMONIZE_PASSAGE_URL]: async () => ({ suggestions: [HARMONY] }),
    })
    const { result } = render(true)
    await vi.advanceTimersByTimeAsync(500)
    await waitFor(() => expect(result.current!.store.forCell("JHN 6:27", "has set his seal.")).toHaveLength(1))
    expect(result.current!.store.forCell("JHN 6:27", "has set his seal.")[0]).toMatchObject({
      tier: "harmonize", old: "seal.", new: "seal.”", reasonKey: "harmonizer.quotes.closeHere",
    })
  })

  it("makes no harmonizer request with the flag off", async () => {
    const fetchMock = stub({ [SMART_EDITS_SUGGEST_URL]: async () => ({ suggestions: [] }) })
    render(false)
    await vi.advanceTimersByTimeAsync(500)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls.map((c) => c[0])).not.toContain(HARMONIZE_PASSAGE_URL)
  })
})

describe("fetchHarmonizerSuggestions", () => {
  it("drops malformed suggestions and never throws", async () => {
    stub({ [HARMONIZE_PASSAGE_URL]: async () => ({ suggestions: [HARMONY, { cellId: 3 }, null] }) })
    const out = await fetchHarmonizerSuggestions({ projectId: "p1", lane: "", cells: [] }, "jwt")
    expect(out).toHaveLength(1)

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
    await expect(fetchHarmonizerSuggestions({ projectId: "p1", lane: "", cells: [] }, "jwt")).resolves.toEqual([])
  })
})
