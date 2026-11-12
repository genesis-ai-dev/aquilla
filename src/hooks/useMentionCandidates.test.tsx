import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { ProjectMember } from "@/lib/frontier/members"

const { fetchMentionCandidates } = vi.hoisted(() => ({ fetchMentionCandidates: vi.fn() }))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt" } }),
}))
vi.mock("@/lib/frontier/members", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/frontier/members")>()
  return { ...actual, fetchMentionCandidates }
})

import { useMentionCandidates } from "./useMentionCandidates"

function member(username: string, userId = 1): ProjectMember {
  return {
    userId,
    username,
    role: { level: 400, name: "contributor", source: "override" },
    secondarySources: [],
  }
}

beforeEach(() => {
  fetchMentionCandidates.mockReset()
})

/**
 * AQU-1815: the comment composer's @mention list. The roster is the list
 * whenever the caller may read it; below the org's roster floor the roster
 * read 403s (`rosterHidden`) and the hook asks the mention-candidates
 * endpoint for the lane-scoped subset instead.
 */
describe("useMentionCandidates", () => {
  it("serves the roster, unrestricted, without a second request when the roster is readable", () => {
    const { result } = renderHook(() =>
      useMentionCandidates("p1", { members: [member("alice"), member("bob", 2)], rosterHidden: false }),
    )
    expect(result.current.candidates).toEqual([{ username: "alice" }, { username: "bob" }])
    expect(result.current.restricted).toBe(false)
    expect(fetchMentionCandidates).not.toHaveBeenCalled()
  })

  it("flags the list restricted at once and fills it from the mention-candidates read when the roster is hidden", async () => {
    fetchMentionCandidates.mockResolvedValue({
      candidates: [{ userId: 2, username: "bob" }, { userId: 3, username: "mia" }],
      restricted: true,
    })
    const { result } = renderHook(() =>
      useMentionCandidates("p1", { members: [], rosterHidden: true }),
    )
    // Before the read lands: empty but already not "no one on this project".
    expect(result.current.candidates).toEqual([])
    expect(result.current.restricted).toBe(true)
    await waitFor(() => {
      expect(result.current.candidates.map((c) => c.username)).toEqual(["bob", "mia"])
    })
    expect(result.current.restricted).toBe(true)
    expect(fetchMentionCandidates).toHaveBeenCalledWith("jwt", "p1")
  })

  it("keeps an empty restricted list when the read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    fetchMentionCandidates.mockRejectedValue(new Error("boom"))
    const { result } = renderHook(() =>
      useMentionCandidates("p1", { members: [], rosterHidden: true }),
    )
    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(result.current.candidates).toEqual([])
    expect(result.current.restricted).toBe(true)
    warn.mockRestore()
  })

  it("never shows one project's lane-mates on another project", async () => {
    fetchMentionCandidates.mockImplementation(async (_jwt: string, projectId: string) => ({
      candidates: projectId === "p1" ? [{ userId: 2, username: "bob" }] : [{ userId: 9, username: "zed" }],
      restricted: true,
    }))
    const { result, rerender } = renderHook(
      ({ projectId }) => useMentionCandidates(projectId, { members: [], rosterHidden: true }),
      { initialProps: { projectId: "p1" } },
    )
    await waitFor(() => expect(result.current.candidates.map((c) => c.username)).toEqual(["bob"]))
    rerender({ projectId: "p2" })
    expect(result.current.candidates.map((c) => c.username)).not.toContain("bob")
    await waitFor(() => expect(result.current.candidates.map((c) => c.username)).toEqual(["zed"]))
  })
})
