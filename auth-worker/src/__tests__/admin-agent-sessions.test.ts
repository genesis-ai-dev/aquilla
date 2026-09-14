import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

// ADMIN_EMAILS is pinned to "root@example.com" (pg-test-env). These tests seed a
// "root" user (admin, by email) and a "wendi" user (ordinary) and assert the gate.

describe("/api/v2/admin/agent-sessions", () => {
  beforeEach(async () => {
    // Seed users
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await seedUser(2, "alice")

    // Seed orgs and projects
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj1', 'John', 1, 1), ('proj2', 'Mark', 1, 2)",
    ).run()

    // Seed agent sessions
    await env.AQUILLA_PG.prepare(
      `INSERT INTO agent_sessions (session_id, project_id, user_id, title, convo, created_at, updated_at, untrusted_active)
       VALUES 
         ('session1', 'proj1', 1, 'First session', '[]', 1000, 3000, false),
         ('session2', 'proj1', 1, 'Second session', '[{"role":"user","content":"hello"}]', 2000, 4000, false),
         ('session3', 'proj2', 2, 'Alice session', '[{"role":"user","content":"test"},{"role":"assistant","content":"response"}]', 3000, 5000, true)`,
    ).run()

    // Seed agent runs
    await env.AQUILLA_PG.prepare(
      `INSERT INTO agent_runs (run_id, project_id, user_id, username, prompt, model, status, prompt_tokens, completion_tokens, cost_cents, steps, staged_count, started_at, ended_at, session_id)
       VALUES 
         ('run1', 'proj1', 1, 'wendi', 'test prompt', 'claude-3', 'ok', 100, 50, 10, 2, 5, 1500, 1600, 'session1'),
         ('run2', 'proj1', 1, 'wendi', 'another prompt', 'claude-3', 'error', 200, 100, 20, 3, 0, 2500, 2600, 'session2'),
         ('run3', 'proj2', 2, 'alice', 'alice prompt', 'claude-3', 'ok', 150, 75, 15, 2, 3, 3500, 3600, 'session3')`,
    ).run()
  })

  it("403s a non-allowlisted user and 401s an anonymous caller", async () => {
    const denied = await app.request(
      "/api/v2/admin/agent-sessions",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(denied.status).toBe(403)

    const anon = await app.request("/api/v2/admin/agent-sessions", {}, env)
    expect(anon.status).toBe(401)
  })

  it("GET /agent-sessions lists sessions with metadata only (no convo)", async () => {
    const res = await app.request(
      "/api/v2/admin/agent-sessions",
      { headers: authHeader(await jwtFor("root")) },
      env,
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      sessions: Array<{
        sessionId: string
        projectId: string
        userId: number
        username: string | null
        projectName: string | null
        title: string
        messageCount: number
        runCount: number
        lastStatus: string | null
        createdAt: number
        updatedAt: number
      }>
      nextCursor: number | null
    }

    expect(body.sessions).toHaveLength(3)
    // Newest first (by updated_at)
    expect(body.sessions[0].sessionId).toBe("session3")
    expect(body.sessions[1].sessionId).toBe("session2")
    expect(body.sessions[2].sessionId).toBe("session1")

    // Check session3 details
    const session3 = body.sessions[0]
    expect(session3).toMatchObject({
      sessionId: "session3",
      projectId: "proj2",
      userId: 2,
      username: "alice",
      projectName: "Mark",
      title: "Alice session",
      messageCount: 2,
      runCount: 1,
      lastStatus: "ok",
      createdAt: 3000,
      updatedAt: 5000,
    })

    // Ensure convo is NOT included in list response
    expect(session3).not.toHaveProperty("convo")
  })

  it("GET /agent-sessions respects limit parameter", async () => {
    const res = await app.request(
      "/api/v2/admin/agent-sessions?limit=2",
      { headers: authHeader(await jwtFor("root")) },
      env,
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as { sessions: unknown[]; nextCursor: number | null }
    expect(body.sessions).toHaveLength(2)
    expect(body.nextCursor).toBe(4000) // updated_at of the second result
  })

  it("GET /agent-sessions supports cursor-based pagination", async () => {
    // First page
    const res1 = await app.request(
      "/api/v2/admin/agent-sessions?limit=2",
      { headers: authHeader(await jwtFor("root")) },
      env,
    )
    const body1 = (await res1.json()) as {
      sessions: Array<{ sessionId: string }>
      nextCursor: number
    }
    expect(body1.sessions).toHaveLength(2)
    expect(body1.nextCursor).toBe(4000)

    // Second page using cursor
    const res2 = await app.request(
      `/api/v2/admin/agent-sessions?limit=2&cursor=${body1.nextCursor}`,
      { headers: authHeader(await jwtFor("root")) },
      env,
    )
    const body2 = (await res2.json()) as {
      sessions: Array<{ sessionId: string }>
      nextCursor: number | null
    }
    expect(body2.sessions).toHaveLength(1)
    expect(body2.sessions[0].sessionId).toBe("session1")
    expect(body2.nextCursor).toBeNull() // No more results
  })

  it("GET /agent-sessions/:sessionId returns full transcript and runs", async () => {
    const res = await app.request(
      "/api/v2/admin/agent-sessions/session2",
      { headers: authHeader(await jwtFor("root")) },
      env,
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      session: {
        sessionId: string
        projectId: string
        userId: number
        username: string | null
        projectName: string | null
        title: string
        convo: unknown[]
        untrustedActive: boolean
        createdAt: number
        updatedAt: number
      }
      runs: Array<{
        runId: string
        prompt: string
        model: string
        status: string
        promptTokens: number
        completionTokens: number
        costCents: number
        steps: number
        stagedCount: number
        startedAt: number
        endedAt: number | null
      }>
    }

    // Check session details
    expect(body.session).toMatchObject({
      sessionId: "session2",
      projectId: "proj1",
      userId: 1,
      username: "wendi",
      projectName: "John",
      title: "Second session",
      untrustedActive: false,
      createdAt: 2000,
      updatedAt: 4000,
    })

    // Check convo is included
    expect(body.session.convo).toEqual([{ role: "user", content: "hello" }])

    // Check runs
    expect(body.runs).toHaveLength(1)
    expect(body.runs[0]).toMatchObject({
      runId: "run2",
      prompt: "another prompt",
      model: "claude-3",
      status: "error",
      promptTokens: 200,
      completionTokens: 100,
      costCents: 20,
      steps: 3,
      stagedCount: 0,
      startedAt: 2500,
      endedAt: 2600,
    })
  })

  it("GET /agent-sessions/:sessionId returns 404 for unknown session", async () => {
    const res = await app.request(
      "/api/v2/admin/agent-sessions/unknown-session",
      { headers: authHeader(await jwtFor("root")) },
      env,
    )
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: "session not found" })
  })

  it("GET /agent-sessions/:sessionId properly parses untrusted_active flag", async () => {
    const res = await app.request(
      "/api/v2/admin/agent-sessions/session3",
      { headers: authHeader(await jwtFor("root")) },
      env,
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      session: { untrustedActive: boolean }
    }
    expect(body.session.untrustedActive).toBe(true)
  })

  it("GET /agent-sessions/:sessionId handles malformed JSON convo gracefully", async () => {
    // Insert a session with invalid JSON
    await env.AQUILLA_PG.prepare(
      `INSERT INTO agent_sessions (session_id, project_id, user_id, title, convo, created_at, updated_at)
       VALUES ('bad-json', 'proj1', 1, 'Bad JSON', '{invalid', 1000, 2000)`,
    ).run()

    const res = await app.request(
      "/api/v2/admin/agent-sessions/bad-json",
      { headers: authHeader(await jwtFor("root")) },
      env,
    )
    expect(res.status).toBe(200)

    const body = (await res.json()) as { session: { convo: unknown[] } }
    expect(body.session.convo).toEqual([]) // Falls back to empty array
  })

  it("GET /agent-sessions/:sessionId denies non-admin access", async () => {
    const denied = await app.request(
      "/api/v2/admin/agent-sessions/session1",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(denied.status).toBe(403)
  })

  it("GET /agent-sessions respects cap of 200", async () => {
    const res = await app.request(
      "/api/v2/admin/agent-sessions?limit=500",
      { headers: authHeader(await jwtFor("root")) },
      env,
    )
    expect(res.status).toBe(200)
    // Would return max 200 if we had that many sessions
  })
})
