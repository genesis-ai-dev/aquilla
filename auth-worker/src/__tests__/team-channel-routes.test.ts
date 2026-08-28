// Durable team channel HTTP surface (routes/team.ts, 2026-08-28
// social-workspace design §v2).
//
// WHY these assertions: this router is the shared, multiplayer history behind
// the one-channel workspace, so what matters is (a) the message MODEL round
// trips — a human can speak in the main channel and in a work thread, and
// everyone pages the same ordered history back; (b) the author is the
// authenticated session and never the request body, because a forged author
// is the one thing a shared record cannot survive; (c) the write floor is
// CONTRIBUTOR, matching contextual steering, which this endpoint is the
// conversational sibling of; and (d) archiving a project freezes discussion
// without destroying the audit trail.
//
// Ported from auth-worker/src/__tests__/team-threads.test.ts on the AQU-1053
// worktree branch. The release-flag cases are intentionally absent — this
// surface ships unflagged on dev (see routes/team.ts).

import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import app from "../index"
import { authHeader, jwtFor, seedUser } from "./helpers/db"
import { appendMessage, ensureThread } from "../lib/team-channel"
import type { TeamMessage, TeamMessagePage, TeamThread } from "../../../shared/team-channel"

const PROJECT = "proj-team"
const base = `/api/v2/projects/${PROJECT}/team`

let alice: string // OWNER via created_by
let bob: string // CONTRIBUTOR member
let viewer: string // VIEWER member — below the write floor
let outsider: string // no membership at all

async function call(path: string, jwt: string, body?: unknown): Promise<Response> {
  return app.request(
    path,
    {
      method: body === undefined ? "GET" : "POST",
      headers: authHeader(jwt),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  )
}

async function post(
  jwt: string,
  body: Record<string, unknown>,
): Promise<{ status: number; message: TeamMessage }> {
  const res = await call(`${base}/messages`, jwt, body)
  return { status: res.status, message: (await res.json()) as TeamMessage }
}

async function mainChannel(jwt = alice, query = ""): Promise<TeamMessagePage> {
  const res = await call(`${base}/messages${query}`, jwt)
  expect(res.status).toBe(200)
  return (await res.json()) as TeamMessagePage
}

async function makeThread(title = "GEN 1"): Promise<TeamThread> {
  const { thread } = await ensureThread(env.AQUILLA_PG, {
    projectId: PROJECT,
    sourceKind: "run",
    sourceRef: `run-${title}`,
    title,
  })
  return thread
}

beforeEach(async () => {
  await seedUser(1, "alice")
  await seedUser(2, "bob")
  await seedUser(3, "viewer")
  await seedUser(4, "outsider")
  alice = await jwtFor("alice")
  bob = await jwtFor("bob")
  viewer = await jwtFor("viewer")
  outsider = await jwtFor("outsider")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, created_by) VALUES (?, 'Translation', 1)",
  )
    .bind(PROJECT)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level) VALUES (?, 2, 400), (?, 3, 100)",
  )
    .bind(PROJECT, PROJECT)
    .run()
})

describe("team channel messages", () => {
  it("round-trips human messages through the main channel and a work thread", async () => {
    const thread = await makeThread()

    const first = await post(alice, { text: "Starting on Genesis today." })
    expect(first.status).toBe(201)
    expect(first.message.threadId).toBeNull()
    // The author comes from the session, not the payload.
    expect(first.message.author).toEqual({ kind: "human", id: "alice" })
    expect(first.message.bodyKind).toBe("text")
    expect(first.message.body).toEqual({ text: "Starting on Genesis today." })
    expect(first.message.createdAt).toMatch(/Z$/)

    const second = await post(bob, { text: "I'll review the drafts." })
    expect(second.status).toBe(201)
    const inThread = await post(bob, { threadId: thread.id, text: "Use the approved term." })
    expect(inThread.status).toBe(201)
    expect(inThread.message.threadId).toBe(thread.id)

    // Main channel: newest LAST, and thread traffic stays out of it.
    const main = await mainChannel(viewer)
    expect(main.messages.map((m) => (m.body as { text: string }).text)).toEqual([
      "Starting on Genesis today.",
      "I'll review the drafts.",
    ])
    expect(main.hasMore).toBe(false)
    expect(main.nextBefore).toBeNull()

    const res = await call(`${base}/threads/${thread.id}/messages`, viewer)
    expect(res.status).toBe(200)
    const page = (await res.json()) as TeamMessagePage & { thread: TeamThread }
    expect(page.thread.id).toBe(thread.id)
    expect(page.thread.sourceKind).toBe("run")
    expect(page.messages.map((m) => m.id)).toEqual([inThread.message.id])
  })

  it("pages backwards and forwards without skipping or repeating a message", async () => {
    for (const text of ["one", "two", "three"]) await post(alice, { text })

    const newest = await mainChannel(alice, "?limit=1")
    expect(newest.messages.map((m) => (m.body as { text: string }).text)).toEqual(["three"])
    expect(newest.hasMore).toBe(true)
    expect(newest.nextBefore).toBe(newest.messages[0].id)

    const older = await mainChannel(alice, `?limit=1&before=${newest.nextBefore}`)
    expect(older.messages.map((m) => (m.body as { text: string }).text)).toEqual(["two"])

    const oldest = await mainChannel(alice, `?limit=1&before=${older.nextBefore}`)
    expect(oldest.messages.map((m) => (m.body as { text: string }).text)).toEqual(["one"])
    expect(oldest.hasMore).toBe(false)
    expect(oldest.nextBefore).toBeNull()

    // Forward (live-tail) reads pick up strictly newer messages.
    const tail = await mainChannel(alice, `?after=${oldest.messages[0].id}`)
    expect(tail.messages.map((m) => (m.body as { text: string }).text)).toEqual(["two", "three"])

    const unknown = await call(`${base}/messages?before=${crypto.randomUUID()}`, alice)
    expect(unknown.status).toBe(400)
    const both = await call(
      `${base}/messages?before=${newest.nextBefore}&after=${newest.nextBefore}`,
      alice,
    )
    expect(both.status).toBe(400)
  })

  it("replays a retried post and refuses a different message under a used id", async () => {
    const id = crypto.randomUUID()
    const first = await post(alice, { id, text: "Sent once" })
    expect(first.status).toBe(201)
    const retry = await post(alice, { id, text: "Sent once" })
    expect(retry.status).toBe(201)
    expect(retry.message).toEqual(first.message)

    const conflict = await call(`${base}/messages`, alice, { id, text: "Different" })
    expect(conflict.status).toBe(409)
    // A retry must not have doubled the history.
    expect((await mainChannel()).messages).toHaveLength(1)
  })

  it("holds the CONTRIBUTOR write floor while keeping reads open to members", async () => {
    // VIEWER (100) is below CONTRIBUTOR (400): can read, cannot speak.
    expect((await call(`${base}/messages`, viewer)).status).toBe(200)
    expect((await call(`${base}/messages`, viewer, { text: "No" })).status).toBe(403)

    // A non-member sees nothing at all, read or write.
    expect((await call(`${base}/messages`, outsider)).status).toBe(403)
    expect((await call(`${base}/messages`, outsider, { text: "No" })).status).toBe(403)

    // Revocation takes effect immediately.
    await env.AQUILLA_PG.prepare("DELETE FROM project_members WHERE user_id = 2").run()
    expect((await call(`${base}/messages`, bob, { text: "No" })).status).toBe(403)
  })

  it("rejects a forged author and an unknown thread", async () => {
    const forged = await call(`${base}/messages`, alice, {
      text: "Fake",
      author: { kind: "persona", id: "coordinator" },
    })
    expect(forged.status).toBe(400)

    const stray = await call(`${base}/messages`, alice, {
      threadId: crypto.randomUUID(),
      text: "Nowhere",
    })
    expect(stray.status).toBe(404)
    expect((await call(`${base}/threads/${crypto.randomUUID()}/messages`, alice)).status).toBe(404)
  })

  it("freezes discussion on an archived project but preserves the history", async () => {
    await post(alice, { text: "Before archiving" })
    await env.AQUILLA_PG.prepare("UPDATE projects SET is_active = false WHERE id = ?")
      .bind(PROJECT)
      .run()

    expect((await call(`${base}/messages`, alice, { text: "After" })).status).toBe(409)
    const main = await mainChannel()
    expect(main.messages.map((m) => (m.body as { text: string }).text)).toEqual([
      "Before archiving",
    ])
  })

  it("keeps personas and humans in one ordered history", async () => {
    // Ingestion writes persona messages directly; the read surface must not
    // treat them as second-class or drop them from the channel.
    await appendMessage(env.AQUILLA_PG, {
      projectId: PROJECT,
      threadId: null,
      author: { kind: "persona", id: "coordinator" },
      bodyKind: "text",
      body: { text: "Working on GEN 1", threadId: crypto.randomUUID() },
    })
    await post(alice, { text: "Thanks" })
    const main = await mainChannel()
    expect(main.messages.map((m) => m.author)).toEqual([
      { kind: "persona", id: "coordinator" },
      { kind: "human", id: "alice" },
    ])
  })

  it("scopes the channel to one project", async () => {
    await post(alice, { text: "Project one" })
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, created_by) VALUES ('other', 'Other', 1)",
    ).run()
    const other = await call("/api/v2/projects/other/team/messages", alice)
    expect(other.status).toBe(200)
    expect(((await other.json()) as TeamMessagePage).messages).toEqual([])
  })
})
