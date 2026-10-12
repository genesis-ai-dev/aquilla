// Team chat history HTTP surface (AQU-1653).
//
// WHY: these two reads are what let the UI offer "New chat" at all — before
// them, a reset put the conversation out of reach. That makes them the first
// route pair that hands one member's agent conversations back over HTTP, so the
// tests here are about the wall around them rather than the happy path: the
// (project, user) scope on the list, and the deliberate inability of the
// single-read to tell "not yours" apart from "does not exist". A 403 on
// someone else's session id would confirm it exists, which is the leak.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { saveSession } from "../lib/agent/sessions"
import { ROLE } from "../types"

const PROJECT = "proj-chat-history"
const OTHER_PROJECT = "proj-chat-history-other"
const MINE = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const THEIRS = "bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

async function seedProject(projectId: string, createdBy: number): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)")
    .bind(projectId, "Chat History Project", createdBy)
    .run()
}

async function grant(projectId: string, userId: number, role: number): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, ?)",
  )
    .bind(projectId, userId, role, userId)
    .run()
}

function get(path: string, jwt: string) {
  return app.request(`/api/v2/projects/${path}`, { method: "GET", headers: authHeader(jwt) }, env)
}

let aliceJwt = ""
let bobJwt = ""
let carolJwt = ""

beforeEach(async () => {
  await seedUser(31, "alice")
  await seedUser(32, "bob")
  await seedUser(33, "carol")
  aliceJwt = await jwtFor("alice")
  bobJwt = await jwtFor("bob")
  carolJwt = await jwtFor("carol")
  await seedProject(PROJECT, 31)
  await seedProject(OTHER_PROJECT, 31)
  await grant(PROJECT, 31, ROLE.VIEWER)
  await grant(PROJECT, 32, ROLE.PROJECT_LEAD)
  await grant(OTHER_PROJECT, 31, ROLE.VIEWER)

  await saveSession(env.AQUILLA_PG, {
    sessionId: MINE,
    projectId: PROJECT,
    userId: 31,
    convo: [
      { role: "user", content: "Draft GEN 1" },
      { role: "tool", tool_call_id: "tc1", content: "cell_id|value\n#c1|In the beginning" },
      { role: "assistant", content: "Staged 1 draft." },
    ],
  })
  await saveSession(env.AQUILLA_PG, {
    sessionId: THEIRS,
    projectId: PROJECT,
    userId: 32,
    convo: [{ role: "user", content: "Bob's private question" }],
  })
})

describe("GET /:projectId/agent-sessions", () => {
  it("returns the caller's own chats and nobody else's", async () => {
    const res = await get(`${PROJECT}/agent-sessions`, aliceJwt)
    expect(res.status).toBe(200)
    const { sessions } = (await res.json()) as {
      sessions: { sessionId: string; title: string }[]
    }
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ sessionId: MINE, title: "Draft GEN 1" })
  })

  it("does not leak a project lead's own chats to a viewer, or the viewer's to the lead", async () => {
    // Role does NOT widen this read: bob is PROJECT_LEAD and still sees only
    // his own conversation. A chat is personal, not project data.
    const res = await get(`${PROJECT}/agent-sessions`, bobJwt)
    const { sessions } = (await res.json()) as { sessions: { sessionId: string }[] }
    expect(sessions.map((s) => s.sessionId)).toEqual([THEIRS])
  })

  it("is empty on a project where the caller has had no chats", async () => {
    const res = await get(`${OTHER_PROJECT}/agent-sessions`, aliceJwt)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sessions: [] })
  })

  it("refuses a caller with no access to the project", async () => {
    const res = await get(`${PROJECT}/agent-sessions`, carolJwt)
    expect(res.status).toBe(403)
    expect((await res.json() as { error: { code: string } }).error.code).toBe("permission_denied")
  })

  it("refuses an unauthenticated caller", async () => {
    const res = await app.request(`/api/v2/projects/${PROJECT}/agent-sessions`, { method: "GET" }, env)
    expect(res.status).toBe(401)
  })
})

describe("GET /:projectId/agent-sessions/:sessionId", () => {
  it("returns the chat as readable turns, without the tool traffic", async () => {
    const res = await get(`${PROJECT}/agent-sessions/${MINE}`, aliceJwt)
    expect(res.status).toBe(200)
    const { session } = (await res.json()) as {
      session: { sessionId: string; title: string; turns: { role: string; text: string }[] }
    }
    expect(session.sessionId).toBe(MINE)
    expect(session.title).toBe("Draft GEN 1")
    // The tool result the model worked from is not a message anyone saw, and
    // (post-compaction) is a digest rather than the real output.
    expect(session.turns).toEqual([
      { role: "user", text: "Draft GEN 1" },
      { role: "assistant", text: "Staged 1 draft." },
    ])
  })

  it("reads another member's chat exactly like one that does not exist", async () => {
    const notMine = await get(`${PROJECT}/agent-sessions/${THEIRS}`, aliceJwt)
    const nonsense = await get(`${PROJECT}/agent-sessions/no-such-session`, aliceJwt)
    // Same status AND same body: a 403, or a different message, would tell
    // alice that bob's session id is real.
    expect(notMine.status).toBe(404)
    expect(nonsense.status).toBe(404)
    expect(await notMine.json()).toEqual(await nonsense.json())
  })

  it("does not serve a chat through a project it does not belong to", async () => {
    const res = await get(`${OTHER_PROJECT}/agent-sessions/${MINE}`, aliceJwt)
    expect(res.status).toBe(404)
  })

  it("refuses a caller with no access to the project", async () => {
    const res = await get(`${PROJECT}/agent-sessions/${MINE}`, carolJwt)
    expect(res.status).toBe(403)
  })
})
