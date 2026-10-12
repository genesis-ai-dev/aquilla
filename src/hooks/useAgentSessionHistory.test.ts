// AQU-1653: the chat menu's list read.
//
// WHY these cases: the menu renders a different row for each of this hook's
// three states, so conflating them misinforms the user. Signed out must not
// read as a failure ("Couldn't load your chats" when nothing was attempted),
// a real failure must not read as an empty history ("No previous chats" when
// the user has plenty), and a reload racing a project switch must not land the
// old project's chats under the new one.

import { describe, it, expect, vi, afterEach } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useAgentSessionHistory } from "./useAgentSessionHistory"
import type { AgentSessionSummary } from "@/lib/agent/session-history"

const listAgentSessions = vi.fn<(jwt: string, projectId: string) => Promise<AgentSessionSummary[]>>()
vi.mock("@/lib/agent/session-history", () => ({
  listAgentSessions: (jwt: string, projectId: string) => listAgentSessions(jwt, projectId),
}))

const row = (id: string): AgentSessionSummary => ({
  sessionId: id,
  title: id,
  createdAt: 1,
  updatedAt: 1,
})

afterEach(() => {
  vi.resetAllMocks()
})

describe("useAgentSessionHistory", () => {
  it("loads the caller's chats", async () => {
    listAgentSessions.mockResolvedValue([row("s1")])
    const { result } = renderHook(() => useAgentSessionHistory("jwt", "p1"))

    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.sessions).toEqual([row("s1")])
    expect(listAgentSessions).toHaveBeenCalledWith("jwt", "p1")
  })

  it("treats signed out as no chats, not as a failure, and makes no request", async () => {
    const { result } = renderHook(() => useAgentSessionHistory(null, "p1"))

    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.sessions).toEqual([])
    expect(listAgentSessions).not.toHaveBeenCalled()
  })

  it("reports a failed read as an error rather than an empty history", async () => {
    listAgentSessions.mockRejectedValue(new Error("boom"))
    const { result } = renderHook(() => useAgentSessionHistory("jwt", "p1"))

    await waitFor(() => expect(result.current.status).toBe("error"))
    expect(result.current.sessions).toEqual([])
  })

  it("refetches on reload", async () => {
    listAgentSessions.mockResolvedValueOnce([row("s1")]).mockResolvedValueOnce([row("s1"), row("s2")])
    const { result } = renderHook(() => useAgentSessionHistory("jwt", "p1"))
    await waitFor(() => expect(result.current.sessions).toHaveLength(1))

    act(() => result.current.reload())
    await waitFor(() => expect(result.current.sessions).toHaveLength(2))
  })

  it("does not land a stale project's chats after the project changes", async () => {
    const slow = new Promise<AgentSessionSummary[]>((resolve) => {
      setTimeout(() => resolve([row("stale")]), 20)
    })
    listAgentSessions.mockReturnValueOnce(slow).mockResolvedValueOnce([row("fresh")])

    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useAgentSessionHistory("jwt", projectId),
      { initialProps: { projectId: "p1" } },
    )
    rerender({ projectId: "p2" })

    await waitFor(() => expect(result.current.sessions).toEqual([row("fresh")]))
    // Let the first request settle after the switch; its rows must be dropped.
    await act(async () => {
      await slow
    })
    expect(result.current.sessions).toEqual([row("fresh")])
    expect(result.current.status).toBe("ready")
  })
})
