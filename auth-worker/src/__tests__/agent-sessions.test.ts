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
