// Smart edits are on for every member of every project, so what one editor
// costs the server is multiplied by everyone with the app open. What matters:
//   - moving through a passage asks about the cell that came into view, not the
//     twenty either side again (each of those would be re-scored and, when the
//     memory is unsure, re-verified by Jev — per step, per person);
//   - a cell is never asked about twice while its first answer is on the way;
//   - an answer for one cell re-renders that cell's row and no other.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt-test" } }),
}))

import { SmartEditsProvider, useSmartEditsForCell, useSmartEditsPassage, type SmartEditsContextValue } from "./useSmartEdits"
import { SmartEditStore } from "@/lib/smart-edits/store"
import type { SmartEditSuggestion } from "@/lib/smart-edits/client"

const IDS = Array.from({ length: 30 }, (_, i) => `c${i}`)
const cellOf = (id: string) => ({ fileId: "f", cellId: id, source: `src ${id}`, target: `the Lord in ${id}` })

function suggestion(cellId: string): SmartEditSuggestion {
  return {
    fileId: "f", cellId, start: 4, end: 8, old: "Lord", oldNorm: "lord", new: "Yahweh", newNorm: "yahweh",
    confidence: 0.9, tier: "memory", support: { strong: 2, weak: 0, keeps: 0 }, examples: [],
  }
}

type SuggestBody = { cells: { cellId: string }[]; only?: string[] }

/** Every suggest request's body, and a way to answer the oldest unanswered one. */
function stubSuggest() {
  const requests: SuggestBody[] = []
  const answers: (() => void)[] = []
  vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as SuggestBody
    requests.push(body)
    return new Promise((resolve) => {
      answers.push(() => resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ suggestions: (body.only ?? []).map(suggestion) }),
      }))
    })
  }))
  return { requests, answer: () => answers.shift()?.() }
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("useSmartEditsPassage", () => {
  it("asks only about cells it has no answer for, and never twice while one is on the way", async () => {
    const { requests, answer } = stubSuggest()
    const { result, rerender } = renderHook(
      ({ active }: { active: string }) =>
        useSmartEditsPassage({
          enabled: true, llmEnabled: false, projectId: "p1", lane: "", cellIds: IDS,
          activeCellId: active, activeText: cellOf(active).target, getCell: cellOf,
        }),
      { initialProps: { active: "c10" } },
    )
    await vi.advanceTimersByTimeAsync(500)
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0].only).toEqual(IDS.slice(0, 21))

    // The translator moves on before the first answer lands: c21 came into
    // view, and it is the only cell worth asking about.
    rerender({ active: "c11" })
    await vi.advanceTimersByTimeAsync(500)
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1].only).toEqual(["c21"])
    // The passage still travels with it, as context.
    expect(requests[1].cells.map((c) => c.cellId)).toEqual(IDS.slice(1, 22))

    // The first answer was not thrown away by the move.
    await act(async () => { answer() })
    await waitFor(() => expect(result.current!.store.forCell("c10", cellOf("c10").target)).toHaveLength(1))

    // Moving back inside what is already answered asks nothing.
    await act(async () => { answer() })
    rerender({ active: "c10" })
    await vi.advanceTimersByTimeAsync(500)
    expect(requests).toHaveLength(2)
  })
})

describe("useSmartEditsForCell", () => {
  it("re-renders a row only when that row's suggestions change", () => {
    const store = new SmartEditStore()
    const value: SmartEditsContextValue = { store, feedback: () => {} }
    const wrapper = ({ children }: { children: ReactNode }) => createElement(SmartEditsProvider, { value }, children)
    const renders = { a: 0, b: 0 }
    const a = renderHook(() => { renders.a++; return useSmartEditsForCell("a", "text a") }, { wrapper })
    renderHook(() => { renders.b++; return useSmartEditsForCell("b", "text b") }, { wrapper })
    const before = { ...renders }

    act(() => store.settle([{ cellId: "a", target: "text a" }], [suggestion("a")]))
    expect(a.result.current.suggestions).toHaveLength(1)
    expect(renders.a).toBeGreaterThan(before.a)
    expect(renders.b).toBe(before.b)

    // Dismissed here: gone from its own row at once.
    act(() => store.hide(a.result.current.suggestions[0]))
    expect(a.result.current.suggestions).toHaveLength(0)
    expect(renders.b).toBe(before.b)
  })
})
