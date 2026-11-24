import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { Concept } from "@/lib/terminology/types"

const fetchConcepts = vi.hoisted(() => vi.fn<(projectId: string, token: string) => Promise<Concept[]>>())
vi.mock("@/lib/sync/concepts-read", () => ({ fetchConcepts }))
vi.mock("@/lib/sync/outbox-flush", () => ({ subscribeAppliedEvents: () => () => {} }))

import { useConcepts } from "./useConcepts"

const getToken = async () => "token"

describe("useConcepts", () => {
  // The glossary shows a "loading" panel while it has no terms and a read is
  // in flight. That is right for the first read and wrong for every later one:
  // removing the last term re-reads an empty list, and the panel flashed over
  // the empty glossary.
  it("reports loading for the first read only, not for a re-read", async () => {
    let answer!: (rows: Concept[]) => void
    fetchConcepts.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    const { result } = renderHook(() => useConcepts({ projectId: "p1", getToken }))
    await waitFor(() => expect(result.current.isLoading).toBe(true))
    await act(async () => {
      answer([])
    })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    let reread!: Promise<void>
    act(() => {
      reread = result.current.refresh()
    })
    await waitFor(() => expect(fetchConcepts).toHaveBeenCalledTimes(2))
    expect(result.current.isLoading).toBe(false)
    await act(async () => {
      answer([])
      await reread
    })
    expect(result.current.isLoading).toBe(false)
  })
})
