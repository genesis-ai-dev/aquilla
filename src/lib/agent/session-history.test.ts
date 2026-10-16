// Team chat history client (AQU-1653).
//
// WHY these tests: reopening a chat is the thing that makes "New chat" safe, so
// the rebuild from a stored conversation has to be faithful about two opposite
// failure modes. It must not DROP model prose (a reply whose user turn fell
// outside the compacted transcript would otherwise vanish), and it must not
// INVENT turns out of tool traffic (tool results were never messages, and after
// compaction they are digests, not what anyone saw). The ownership-404 case is
// here too: a chat that is not yours must read exactly like one that does not
// exist, or the error itself confirms another user's session id.

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  fetchAgentSession,
  listAgentSessions,
  runsFromTurns,
  SessionHistoryError,
  type SessionTurn,
} from "./session-history"

const PROJECT = "proj-1"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("runsFromTurns", () => {
  it("makes one run per user turn, carrying the reply that answered it", () => {
    const turns: SessionTurn[] = [
      { role: "user", text: "Draft GEN 1" },
      { role: "assistant", text: "Staged 2 drafts." },
      { role: "user", text: "Why that wording?" },
      { role: "assistant", text: "The project brief asks for plain speech." },
    ]

    const runs = runsFromTurns(turns)
    expect(runs).toHaveLength(2)
    expect(runs[0].prompt).toBe("Draft GEN 1")
    expect(runs[0].items).toEqual([{ id: "i0", kind: "text", text: "Staged 2 drafts." }])
    expect(runs[1].prompt).toBe("Why that wording?")
    expect(runs[1].items).toEqual([
      { id: "i0", kind: "text", text: "The project brief asks for plain speech." },
    ])
    // Every rebuilt run is terminal and marked as rebuilt — the view must not
    // show a spinner for a run that finished days ago, and must be able to tell
    // that the missing tool chips are expected rather than a rendering bug.
    expect(runs.every((run) => run.status === "ok")).toBe(true)
    expect(runs.every((run) => run.restored === true)).toBe(true)
    expect(runs.every((run) => run.runId === null)).toBe(true)
    expect(new Set(runs.map((run) => run.localId)).size).toBe(2)
  })

  it("keeps a reply whose user turn fell outside the stored transcript", () => {
    // Compaction drops from the front at a user-turn boundary, and the
    // autopilot can write into the channel unprompted — either way the first
    // thing in the transcript can be the model speaking. Dropping it would
    // show the user an emptier conversation than they actually had.
    const runs = runsFromTurns([
      { role: "assistant", text: "I finished the chapter you asked about." },
      { role: "user", text: "Thanks — now MRK 5" },
      { role: "assistant", text: "Staged 4 drafts." },
    ])
    expect(runs).toHaveLength(2)
    expect(runs[0].prompt).toBe("")
    expect(runs[0].items).toEqual([
      { id: "i0", kind: "text", text: "I finished the chapter you asked about." },
    ])
    expect(runs[1].prompt).toBe("Thanks — now MRK 5")
  })

  it("does not fold a second reply into the run that already has one", () => {
    // Two assistant turns in a row reach the client already joined by the
    // server (transcriptTurns does that). If one ever arrives unjoined, the
    // later reply must still be visible rather than overwriting the earlier.
    const runs = runsFromTurns([
      { role: "user", text: "Check GEN 1" },
      { role: "assistant", text: "First pass done." },
      { role: "assistant", text: "Second pass done." },
    ])
    expect(runs).toHaveLength(2)
    expect(runs[0].items).toEqual([{ id: "i0", kind: "text", text: "First pass done." }])
    expect(runs[1].items).toEqual([{ id: "i0", kind: "text", text: "Second pass done." }])
  })

  it("returns nothing for an empty transcript", () => {
    expect(runsFromTurns([])).toEqual([])
  })
})

describe("listAgentSessions", () => {
  it("returns the server's rows", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        sessions: [{ sessionId: "s1", title: "Draft GEN 1", createdAt: 1, updatedAt: 2 }],
      }),
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(listAgentSessions("jwt", PROJECT)).resolves.toEqual([
      { sessionId: "s1", title: "Draft GEN 1", createdAt: 1, updatedAt: 2 },
    ])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain(`/api/v2/projects/${PROJECT}/agent-sessions`)
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt")
  })

  it("reads a response with no sessions key as no chats, not as undefined", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})))
    await expect(listAgentSessions("jwt", PROJECT)).resolves.toEqual([])
  })

  it("throws with the server's status so the menu can say the list failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: "permission_denied", message: "nope" } }, 403)),
    )
    await expect(listAgentSessions("jwt", PROJECT)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("nope"),
    })
    await expect(listAgentSessions("jwt", PROJECT)).rejects.toBeInstanceOf(SessionHistoryError)
  })
})

describe("fetchAgentSession", () => {
  it("unwraps the session envelope", async () => {
    const session = {
      sessionId: "s1",
      title: "Draft GEN 1",
      createdAt: 1,
      updatedAt: 2,
      turns: [{ role: "user", text: "Draft GEN 1" }],
    }
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ session })))
    await expect(fetchAgentSession("jwt", PROJECT, "s1")).resolves.toEqual(session)
  })

  it("surfaces a 404 for a chat that is not the caller's", async () => {
    // The server deliberately cannot distinguish "no such chat" from "someone
    // else's chat"; the client must not pretend to either.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: { code: "not_found", message: "no such chat on this project" } }, 404)),
    )
    await expect(fetchAgentSession("jwt", PROJECT, "someone-elses")).rejects.toMatchObject({
      status: 404,
    })
  })

  it("still throws when the error body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502</html>", { status: 502 })))
    await expect(fetchAgentSession("jwt", PROJECT, "s1")).rejects.toMatchObject({ status: 502 })
  })
})
