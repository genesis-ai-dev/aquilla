import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useTeamDirectory } from "./useTeamDirectory"

const listTeamsPage = vi.fn()
vi.mock("@/lib/frontier/teams", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/frontier/teams")>()
  return {
    ...actual,
    listTeamsPage: (...a: unknown[]) => listTeamsPage(...a),
  }
})

beforeEach(() => {
  listTeamsPage.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("useTeamDirectory", () => {
  it("does not fetch until enabled with a jwt and orgId", async () => {
    listTeamsPage.mockResolvedValue({ groups: [], nextCursor: null })
    const { rerender } = renderHook(
      (props: { jwt: string | null; enabled: boolean; orgId: number | null }) =>
        useTeamDirectory({ query: "", visibility: "all", ...props }),
      { initialProps: { jwt: null, enabled: true, orgId: 1 } },
    )
    expect(listTeamsPage).not.toHaveBeenCalled()
    rerender({ jwt: "jwt", enabled: false, orgId: 1 })
    expect(listTeamsPage).not.toHaveBeenCalled()
    rerender({ jwt: "jwt", enabled: true, orgId: null })
    expect(listTeamsPage).not.toHaveBeenCalled()
    rerender({ jwt: "jwt", enabled: true, orgId: 1 })
    await waitFor(() => expect(listTeamsPage).toHaveBeenCalledTimes(1))
  })

  it("replaces the list on a new query and appends on loadMore", async () => {
    listTeamsPage
      .mockResolvedValueOnce({
        groups: [{ id: 1, name: "Alpha", memberCount: 1, projectCount: 0, viewerIsMember: true, isInternal: true }],
        nextCursor: "1:Alpha",
      })
      .mockResolvedValueOnce({
        groups: [{ id: 2, name: "Beta", memberCount: 1, projectCount: 0, viewerIsMember: true, isInternal: true }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        groups: [{ id: 3, name: "Gamma", memberCount: 1, projectCount: 0, viewerIsMember: true, isInternal: true }],
        nextCursor: null,
      })

    const { result, rerender } = renderHook(
      ({ query }: { query: string }) =>
        useTeamDirectory({ jwt: "jwt", enabled: true, orgId: 1, query, visibility: "internal" }),
      { initialProps: { query: "" } },
    )

    await waitFor(() => expect(result.current.teams.map((t) => t.id)).toEqual([1]))
    expect(result.current.hasMore).toBe(true)

    await act(async () => {
      result.current.loadMore()
    })
    await waitFor(() => expect(result.current.teams.map((t) => t.id)).toEqual([1, 2]))
    expect(result.current.hasMore).toBe(false)

    rerender({ query: "gam" })
    expect(result.current.searching).toBe(true)
    await waitFor(() => expect(result.current.teams.map((t) => t.name)).toEqual(["Gamma"]))
    expect(result.current.searching).toBe(false)
  })

  it("refetches when visibility changes", async () => {
    listTeamsPage
      .mockResolvedValueOnce({
        groups: [{ id: 1, name: "Internal", memberCount: 1, projectCount: 0, viewerIsMember: true, isInternal: true }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        groups: [{ id: 2, name: "Public", memberCount: 1, projectCount: 0, viewerIsMember: true, isInternal: false }],
        nextCursor: null,
      })

    const { result, rerender } = renderHook(
      ({ visibility }: { visibility: "all" | "internal" | "public" }) =>
        useTeamDirectory({ jwt: "jwt", enabled: true, orgId: 1, query: "", visibility }),
      { initialProps: { visibility: "internal" as const } },
    )

    await waitFor(() => expect(result.current.teams.map((t) => t.name)).toEqual(["Internal"]))
    rerender({ visibility: "public" })
    await waitFor(() => expect(result.current.teams.map((t) => t.name)).toEqual(["Public"]))
    expect(listTeamsPage).toHaveBeenLastCalledWith(
      "jwt",
      1,
      expect.objectContaining({ visibility: "public" }),
    )
  })
})
