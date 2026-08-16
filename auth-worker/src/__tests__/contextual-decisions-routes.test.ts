// Decision routes (seam design §4.3, §4.6).
// WHY these tests: the surfacing cap is a product promise, not a nicety — a
// user who is shown thirty questions has been handed a queue, which is the
// exact failure the decision channel exists to avoid. And `answer` must be
// role-gated, because answering sets project-wide policy.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { raiseDecision, getDecision } from "../../../db/shared/contextual-decisions"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const db = env.AQUILLA_PG

let userSeq = 0

/** Seed a project plus a member with CONTRIBUTOR-level access (covers both
 *  the VIEWER read floor and the CONTRIBUTOR write floor these routes gate
 *  on) and return that member's signed test JWT. */
async function seedProjectMember(projectId: string): Promise<string> {
  const userId = ++userSeq
  const username = `contrib-${userId}`
  await seedUser(userId, username)
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)",
  )
    .bind(projectId, projectId, userId)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, ?)",
  )
    .bind(projectId, userId, 400, userId)
    .run()
  return jwtFor(username)
}

/** A merely-authenticated user with no project membership at all — enough to
 *  clear authMiddleware, not enough to clear a role gate. */
async function seedBareUser(): Promise<string> {
  const userId = ++userSeq
  const username = `bare-${userId}`
  await seedUser(userId, username)
  return jwtFor(username)
}

/** A member with VIEWER-level access on an EXISTING project — clears the GET
 *  route's VIEWER floor but not the act route's CONTRIBUTOR floor. Unlike
 *  seedBareUser, this proves the role gate itself rejects a real member at
 *  too low a level, not just an unrelated stranger.
 *
 *  Owned by a SEPARATE user: resolveProjectRole gives the project's
 *  `created_by` an implicit level-700 "creator" contribution that wins over
 *  any lower project_members row (max-wins), so a viewer who also created
 *  the project would silently resolve to owner-level and this test would
 *  prove nothing about the gate. */
async function seedProjectViewer(projectId: string): Promise<string> {
  const ownerId = ++userSeq
  await seedUser(ownerId, `owner-${ownerId}`)
  const userId = ++userSeq
  const username = `viewer-${userId}`
  await seedUser(userId, username)
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)",
  )
    .bind(projectId, projectId, ownerId)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, ?)",
  )
    .bind(projectId, userId, 100, ownerId)
    .run()
  return jwtFor(username)
}

async function request(path: string, jwt: string, init?: RequestInit): Promise<Response> {
  return app.request(
    path,
    {
      method: init?.method ?? "GET",
      headers: authHeader(jwt),
      body: init?.body,
    },
    env,
  )
}

describe("GET /contextual/decisions", () => {
  it("surfaces at most the cap, ranked, but reports the true open count", async () => {
    const project = `proj-routes-${Date.now()}`
    const jwt = await seedProjectMember(project)
    for (const radius of [1, 2, 3, 40, 50]) {
      await raiseDecision(db, {
        projectId: project,
        runId: null,
        fileId: "f1",
        reason: `radius ${radius}`,
        blastRadius: radius,
      })
    }

    const res = await request(`/api/v2/projects/${project}/contextual/decisions`, jwt)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.cap).toBe(3)
    expect(body.openCount).toBe(5) // the held ones are still open
    expect(body.decisions).toHaveLength(3) // …but not shown
    expect(body.decisions.map((d: { blastRadius: number }) => d.blastRadius)).toEqual([50, 40, 3])
  })
})

describe("POST /contextual/decisions/:id/:action", () => {
  it("rejects an unknown action rather than silently doing nothing", async () => {
    const jwt = await seedBareUser()
    const res = await request(`/api/v2/projects/p/contextual/decisions/x/explode`, jwt, {
      method: "POST",
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it("answers a decision and returns the resolved row", async () => {
    const project = `proj-answer-${Date.now()}`
    const jwt = await seedProjectMember(project)
    const d = await raiseDecision(db, {
      projectId: project,
      runId: null,
      fileId: "f1",
      reason: "Which rendering?",
    })
    const res = await request(
      `/api/v2/projects/${project}/contextual/decisions/${d.id}/answer`,
      jwt,
      { method: "POST", body: JSON.stringify({ answer: "council" }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.decision.status).toBe("resolved")
  })

  it("returns 409 when answering an already-closed decision", async () => {
    const project = `proj-conflict-${Date.now()}`
    const jwt = await seedProjectMember(project)
    const d = await raiseDecision(db, {
      projectId: project, runId: null, fileId: "f1", reason: "Which rendering?",
    })
    const once = { method: "POST", body: JSON.stringify({ answer: "a" }) }
    await request(`/api/v2/projects/${project}/contextual/decisions/${d.id}/answer`, jwt, once)
    const res = await request(
      `/api/v2/projects/${project}/contextual/decisions/${d.id}/answer`,
      jwt,
      { method: "POST", body: JSON.stringify({ answer: "b" }) },
    )
    expect(res.status).toBe(409)
  })

  // WHY: the file header claims "`answer` must be role-gated", but until now
  // no test actually asserted a 403 — the one bare-user test above hits the
  // unknown-action branch, which short-circuits before requireRole runs, so
  // it proves nothing about the gate. This seeds a REAL project member below
  // the CONTRIBUTOR floor (VIEWER, 100 — sufficient for the GET route but not
  // this one) and checks both the response and that the row was untouched.
  it("viewer-level member → 403 on answer, decision unchanged", async () => {
    const project = `proj-viewer-${Date.now()}`
    const jwt = await seedProjectViewer(project)
    const d = await raiseDecision(db, {
      projectId: project,
      runId: null,
      fileId: "f1",
      reason: "Which rendering?",
    })

    const res = await request(
      `/api/v2/projects/${project}/contextual/decisions/${d.id}/answer`,
      jwt,
      { method: "POST", body: JSON.stringify({ answer: "council" }) },
    )
    expect(res.status).toBe(403)

    const after = await getDecision(db, d.id)
    expect(after?.status).toBe("open")
    expect(after?.resolution).toBeNull()
  })

  // Guards against a cross-project write (IDOR): answering/dismissing must
  // not be reachable through a project a caller isn't a member of, even if
  // they know (or guess — decision ids are time-ordered uuidv7) a decision id
  // that belongs to someone else's project. A status-code-only assertion
  // here would NOT catch a handler that mutates the row and then reports 404
  // after the fact — the write already landed by then. Re-reading the
  // decision and asserting it is untouched is the part that actually proves
  // the fix. Do not simplify this to a status-code check.
  it("404s a cross-project decision id without mutating it", async () => {
    const projectA = `proj-a-${Date.now()}`
    const projectB = `proj-b-${Date.now()}`
    const jwtA = await seedProjectMember(projectA) // CONTRIBUTOR on A only
    await seedProjectMember(projectB) // seeds B's own member/JWT, unused here

    const decisionInB = await raiseDecision(db, {
      projectId: projectB,
      runId: null,
      fileId: "f1",
      reason: "Which rendering?",
    })

    const res = await request(
      `/api/v2/projects/${projectA}/contextual/decisions/${decisionInB.id}/answer`,
      jwtA,
      { method: "POST", body: JSON.stringify({ answer: "smuggled" }) },
    )
    expect(res.status).toBe(404)

    const after = await getDecision(db, decisionInB.id)
    expect(after?.status).toBe("open")
    expect(after?.resolution).toBeNull()
  })
})
