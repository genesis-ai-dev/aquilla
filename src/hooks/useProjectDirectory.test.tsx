import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useProjectDirectory } from "./useProjectDirectory"

const getPortfolioPage = vi.fn()
const getPortfoliosPage = vi.fn()
vi.mock("@/lib/frontier/portfolio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/frontier/portfolio")>()
  return {
    ...actual,
    getPortfolioPage: (...a: unknown[]) => getPortfolioPage(...a),
    getPortfoliosPage: (...a: unknown[]) => getPortfoliosPage(...a),
  }
})

beforeEach(() => {
  getPortfolioPage.mockReset()
  getPortfoliosPage.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("useProjectDirectory", () => {
  it("does not fetch until enabled with a jwt and at least one org", async () => {
    getPortfolioPage.mockResolvedValue({ projects: [], nextCursor: null })
    type Props = { jwt: string | null; enabled: boolean; orgIds: number[] }
    const initialProps: Props = { jwt: null, enabled: true, orgIds: [1] }
    const { rerender } = renderHook(
      (props: Props) => useProjectDirectory({ query: "", ...props }),
      { initialProps },
    )
    expect(getPortfolioPage).not.toHaveBeenCalled()
    rerender({ jwt: "jwt", enabled: false, orgIds: [1] })
    expect(getPortfolioPage).not.toHaveBeenCalled()
    rerender({ jwt: "jwt", enabled: true, orgIds: [] })
    expect(getPortfolioPage).not.toHaveBeenCalled()
    rerender({ jwt: "jwt", enabled: true, orgIds: [1] })
    await waitFor(() => expect(getPortfolioPage).toHaveBeenCalledTimes(1))
  })

  it("replaces the list on a new query and appends on loadMore", async () => {
    getPortfolioPage
      .mockResolvedValueOnce({
        projects: [{ id: "a", name: "Acts", totalCells: 0, validatedCells: 0, filledCells: 0, aiDraftedCells: 0, lastEditAt: null, audioCells: 0, validatedAudioCells: 0, recordedMs: 0, deadlineAt: null }],
        nextCursor: "a:Acts",
      })
      .mockResolvedValueOnce({
        projects: [{ id: "j", name: "John", totalCells: 0, validatedCells: 0, filledCells: 0, aiDraftedCells: 0, lastEditAt: null, audioCells: 0, validatedAudioCells: 0, recordedMs: 0, deadlineAt: null }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        projects: [{ id: "m", name: "Mark", totalCells: 0, validatedCells: 0, filledCells: 0, aiDraftedCells: 0, lastEditAt: null, audioCells: 0, validatedAudioCells: 0, recordedMs: 0, deadlineAt: null }],
        nextCursor: null,
      })

    const { result, rerender } = renderHook(
      ({ query }: { query: string }) =>
        useProjectDirectory({ jwt: "jwt", enabled: true, orgIds: [1], query }),
      { initialProps: { query: "" } },
    )

    await waitFor(() => expect(result.current.projects.map((p) => p.id)).toEqual(["a"]))
    expect(result.current.hasMore).toBe(true)

    await act(async () => {
      result.current.loadMore()
    })
    await waitFor(() => expect(result.current.projects.map((p) => p.id)).toEqual(["a", "j"]))
    expect(result.current.hasMore).toBe(false)

    rerender({ query: "mar" })
    expect(result.current.searching).toBe(true)
    await waitFor(() => expect(result.current.projects.map((p) => p.name)).toEqual(["Mark"]))
    expect(result.current.searching).toBe(false)
  })

  it("fans out through getPortfoliosPage when more than one org is in scope", async () => {
    getPortfoliosPage.mockResolvedValue({
      projects: [
        { id: "a", name: "Acts", orgId: 1, totalCells: 0, validatedCells: 0, filledCells: 0, aiDraftedCells: 0, lastEditAt: null, audioCells: 0, validatedAudioCells: 0, recordedMs: 0, deadlineAt: null },
      ],
      nextCursor: null,
    })
    const { result } = renderHook(() =>
      useProjectDirectory({ jwt: "jwt", enabled: true, orgIds: [2, 1], query: "" }),
    )
    await waitFor(() => expect(result.current.projects.map((p) => p.id)).toEqual(["a"]))
    expect(getPortfolioPage).not.toHaveBeenCalled()
    expect(getPortfoliosPage).toHaveBeenCalledWith(
      "jwt",
      [1, 2],
      expect.objectContaining({ q: "" }),
    )
  })
})
