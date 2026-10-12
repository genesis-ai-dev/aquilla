// agent_sessions — persistence + compaction. WHY: the session store is what
// lets a follow-up turn reuse prior tool results instead of re-discovering
// the project; compaction is what keeps that store from growing without
// bound. The rules that matter: recent turns stay verbatim, old tool results
// shrink to digests, and a truncated transcript never starts mid-exchange.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import {
  compactConvo,
  loadSession,
  saveSession,
  type StoredMessage,
} from "../lib/agent/sessions"

const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const PROJECT = "11111111-1111-4111-8111-111111111111"

describe("saveSession / loadSession", () => {
  it("round-trips a convo including tool messages, and upserts on re-save", async () => {
    const convo: StoredMessage[] = [
      { role: "user", content: "Draft GEN 1" },
      { role: "assistant", content: null, tool_calls: [{ id: "tc1", type: "function", function: { name: "execute", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "tc1", content: "cell_id|value\n#c1|In the beginning" },
      { role: "assistant", content: "Staged 1 draft." },
    ]
    await saveSession(env.AQUILLA_PG, { sessionId: SESSION, projectId: PROJECT, userId: 1, convo })

    const loaded = await loadSession(env.AQUILLA_PG, SESSION)
    expect(loaded).not.toBeNull()
    expect(loaded!.projectId).toBe(PROJECT)
    expect(loaded!.userId).toBe(1)
    expect(loaded!.convo).toEqual(convo)

    // Upsert: extend and re-save under the same id.
    const extended: StoredMessage[] = [...convo, { role: "user", content: "Now GEN 2" }]
    await saveSession(env.AQUILLA_PG, { sessionId: SESSION, projectId: PROJECT, userId: 1, convo: extended })
    const reloaded = await loadSession(env.AQUILLA_PG, SESSION)
    expect(reloaded!.convo).toHaveLength(5)

    // Title is derived from the first user turn.
    const row = await env.AQUILLA_PG.prepare("SELECT title FROM agent_sessions WHERE session_id = ?")
      .bind(SESSION)
      .first<{ title: string }>()
    expect(row!.title).toBe("Draft GEN 1")
  })

  it("returns null for an unknown session id", async () => {
    expect(await loadSession(env.AQUILLA_PG, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toBeNull()
  })
})

describe("compactConvo", () => {
  const bigTool = (id: string): StoredMessage => ({
    role: "tool",
    tool_call_id: id,
    content: "x".repeat(3000),
  })

  it("keeps the last two user turns verbatim and truncates older tool results", () => {
    const convo: StoredMessage[] = [
      { role: "user", content: "turn 1" },
      bigTool("t1"),
      { role: "assistant", content: "done 1" },
      { role: "user", content: "turn 2" },
      bigTool("t2"),
      { role: "assistant", content: "done 2" },
      { role: "user", content: "turn 3" },
      bigTool("t3"),
    ]
    const out = compactConvo(convo)
    // t1 is before the keep-window (last 2 user turns start at "turn 2") → digest.
    expect((out[1] as { content: string }).content).toContain("…[compacted]")
    expect((out[1] as { content: string }).content.length).toBeLessThan(500)
    // t2 and t3 are inside the window → untouched.
    expect((out[4] as { content: string }).content).toHaveLength(3000)
    expect((out[7] as { content: string }).content).toHaveLength(3000)
    // Non-tool messages never change.
    expect(out[0]).toEqual(convo[0])
    expect(out[2]).toEqual(convo[2])
  })

  it("caps total messages and restarts at a user-turn boundary", () => {
    const convo: StoredMessage[] = []
    for (let i = 0; i < 100; i++) {
      convo.push({ role: "user", content: `u${i}` })
      convo.push({ role: "tool", tool_call_id: `t${i}`, content: "r" })
      convo.push({ role: "assistant", content: `a${i}` })
    }
    const out = compactConvo(convo) // 300 messages → capped
    expect(out.length).toBeLessThanOrEqual(120)
    expect(out[0].role).toBe("user")
  })

  it("passes small conversations through unchanged", () => {
    const convo: StoredMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]
    expect(compactConvo(convo)).toEqual(convo)
  })
})

// ── AQU-1653: Team chat history ─────────────────────────────────────────────
// Reading a chat back is what makes "New chat" safe, so these tests encode the
// two things that can go wrong with it. One is privacy: a session belongs to
// (project, user), and a caller must not be able to list — or even confirm the
// existence of — another member's chats. The other is fidelity: the stored
// convo is the MODEL's view, so the transcript must carry the prose and drop
// the tool traffic, which was never a message and is a digest after compaction.

describe("transcriptTurns", () => {
  it("keeps prose and drops tool traffic", async () => {
    const { transcriptTurns } = await import("../lib/agent/sessions")
    const convo: StoredMessage[] = [
      { role: "user", content: "Draft GEN 1" },
      { role: "assistant", content: null, tool_calls: [{ id: "tc1", type: "function", function: { name: "execute", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "tc1", content: "cell_id|value\n#c1|In the beginning" },
      { role: "assistant", content: "Staged 1 draft." },
    ]
    expect(transcriptTurns(convo)).toEqual([
      { role: "user", text: "Draft GEN 1" },
      { role: "assistant", text: "Staged 1 draft." },
    ])
  })

  it("joins prose split across tool calls into one reply", async () => {
    const { transcriptTurns } = await import("../lib/agent/sessions")
    // A live run renders this as one reply with a tool chip in the middle;
    // reading it back as two replies would misrepresent the conversation.
    expect(
      transcriptTurns([
        { role: "user", content: "Check GEN 1" },
        { role: "assistant", content: "Looking at the chapter." },
        { role: "tool", tool_call_id: "tc1", content: "…" },
        { role: "assistant", content: "Two lines need work." },
      ]),
    ).toEqual([
      { role: "user", text: "Check GEN 1" },
      { role: "assistant", text: "Looking at the chapter.\n\nTwo lines need work." },
    ])
  })

  it("skips blank and non-string content rather than emitting empty turns", async () => {
    const { transcriptTurns } = await import("../lib/agent/sessions")
    expect(
      transcriptTurns([
        { role: "assistant", content: null },
        { role: "user", content: "   " },
        { role: "user", content: "Real question" },
      ]),
    ).toEqual([{ role: "user", text: "Real question" }])
  })
})

describe("listSessionsForUser / loadSessionForUser", () => {
  const MINE_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
  const MINE_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
  const THEIRS = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
  const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222"

  async function seedChats(): Promise<void> {
    const { saveSession } = await import("../lib/agent/sessions")
    await saveSession(env.AQUILLA_PG, {
      sessionId: MINE_A, projectId: PROJECT, userId: 7,
      convo: [{ role: "user", content: "Draft GEN 1" }, { role: "assistant", content: "Staged 2." }],
    })
    await saveSession(env.AQUILLA_PG, {
      sessionId: MINE_B, projectId: PROJECT, userId: 7,
      convo: [{ role: "user", content: "Why that wording?" }],
    })
    await saveSession(env.AQUILLA_PG, {
      sessionId: THEIRS, projectId: PROJECT, userId: 8,
      convo: [{ role: "user", content: "Another member's chat" }],
    })
    await env.AQUILLA_PG.prepare("UPDATE agent_sessions SET updated_at = ? WHERE session_id = ?")
      .bind(100, MINE_A)
      .run()
    await env.AQUILLA_PG.prepare("UPDATE agent_sessions SET updated_at = ? WHERE session_id = ?")
      .bind(200, MINE_B)
      .run()
  }

  it("lists only the caller's own chats on the project, newest first", async () => {
    const { listSessionsForUser } = await import("../lib/agent/sessions")
    await seedChats()

    const mine = await listSessionsForUser(env.AQUILLA_PG, PROJECT, 7)
    expect(mine.map((s) => s.sessionId)).toEqual([MINE_B, MINE_A])
    expect(mine.map((s) => s.title)).toEqual(["Why that wording?", "Draft GEN 1"])
    // The other member's chat is on the same project and is not listed.
    expect(mine.some((s) => s.sessionId === THEIRS)).toBe(false)
    expect(await listSessionsForUser(env.AQUILLA_PG, OTHER_PROJECT, 7)).toEqual([])
  })

  it("returns a chat as a readable transcript", async () => {
    const { loadSessionForUser } = await import("../lib/agent/sessions")
    await seedChats()

    const chat = await loadSessionForUser(env.AQUILLA_PG, PROJECT, 7, MINE_A)
    expect(chat).not.toBeNull()
    expect(chat!.title).toBe("Draft GEN 1")
    expect(chat!.turns).toEqual([
      { role: "user", text: "Draft GEN 1" },
      { role: "assistant", text: "Staged 2." },
    ])
  })

  it("reads another member's chat, and a chat on another project, as absent", async () => {
    const { loadSessionForUser } = await import("../lib/agent/sessions")
    await seedChats()

    // All three must be indistinguishable — anything other than null here
    // confirms that someone else's session id exists.
    expect(await loadSessionForUser(env.AQUILLA_PG, PROJECT, 7, THEIRS)).toBeNull()
    expect(await loadSessionForUser(env.AQUILLA_PG, OTHER_PROJECT, 7, MINE_A)).toBeNull()
    expect(await loadSessionForUser(env.AQUILLA_PG, PROJECT, 7, "no-such-session")).toBeNull()
  })

  it("names a chat whose first save carried no user turn, once one arrives", async () => {
    const { saveSession, listSessionsForUser } = await import("../lib/agent/sessions")
    const id = "ffffffff-ffff-4fff-8fff-ffffffffffff"
    // First save is assistant-only (an autopilot write), so there is nothing
    // to take a title from yet.
    await saveSession(env.AQUILLA_PG, {
      sessionId: id, projectId: PROJECT, userId: 9,
      convo: [{ role: "assistant", content: "I had a look at GEN 1." }],
    })
    expect((await listSessionsForUser(env.AQUILLA_PG, PROJECT, 9))[0].title).toBe("")

    await saveSession(env.AQUILLA_PG, {
      sessionId: id, projectId: PROJECT, userId: 9,
      convo: [{ role: "assistant", content: "I had a look at GEN 1." }, { role: "user", content: "Thanks — now MRK 5" }],
    })
    expect((await listSessionsForUser(env.AQUILLA_PG, PROJECT, 9))[0].title).toBe("Thanks — now MRK 5")
  })

  it("never overwrites the title the user has been seeing", async () => {
    const { saveSession, listSessionsForUser } = await import("../lib/agent/sessions")
    const id = "99999999-9999-4999-8999-999999999999"
    await saveSession(env.AQUILLA_PG, {
      sessionId: id, projectId: PROJECT, userId: 9,
      convo: [{ role: "user", content: "Original question" }],
    })
    // Compaction can drop the opening exchange, which would change what
    // "first user turn" means. The chat must not silently rename itself.
    await saveSession(env.AQUILLA_PG, {
      sessionId: id, projectId: PROJECT, userId: 9,
      convo: [{ role: "user", content: "A much later question" }],
    })
    expect((await listSessionsForUser(env.AQUILLA_PG, PROJECT, 9))[0].title).toBe("Original question")
  })
})
