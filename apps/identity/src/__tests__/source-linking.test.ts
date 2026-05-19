// Tests for Phase 1C source-project link/detach + delete-with-downstreams
// gating (Aquilla AD-9 / 03-data-model.md §"Source-project linking").

import { describe, it, expect } from "vitest"
import { sign } from "hono/jwt"
import app from "../index"
import type { Env } from "../types"
import { makeFakeD1, type UserRow } from "./helpers/d1-fake"

const SECRET = "frontier-test-secret"

function makeUser(id: number, username: string): UserRow {
  return {
    id,
    username,
    email: `${username}@example.com`,
    password_hash: "scrypt:32768:8:1$salt$" + "ab".repeat(64),
    preferences: "{}",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

async function frontierJwt(username: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return sign({ sub: username, iat: now, exp: now + 3600 }, SECRET, "HS256")
}

function makeEnv(db: ReturnType<typeof makeFakeD1>): Env {
  return {
    AQUILLA_DB: db,
    SECRET_KEY: SECRET,
    ALGORITHM: "HS256",
    ACCESS_TOKEN_EXPIRE_MINUTES: "60",
    SYNC_SECRET_KEY: "sync-secret",
  }
}

describe("POST /api/v2/projects/:projectId/link-source", () => {
  it("sets source_project_id and emits a project.link-source event", async () => {
    const db = makeFakeD1({
      users: [makeUser(1, "alice")],
      projects: [
        {
          id: "target",
          name: "Spanish",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
        {
          id: "source",
          name: "Greek source",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
      ],
    })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/projects/target/link-source",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sourceProjectId: "source" }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      projectId: string
      sourceProjectId: string
    }
    expect(body).toMatchObject({
      projectId: "target",
      sourceProjectId: "source",
    })

    const target = db._tables().projects.find((p) => p.id === "target")
    expect(target?.source_project_id).toBe("source")

    const events = db._tables().events
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      project_id: "target",
      kind: "project.link-source",
      author: "alice",
    })
    expect(JSON.parse(events[0].payload)).toEqual({ sourceProjectId: "source" })
  })

  it("403s callers below project_lead (500)", async () => {
    const db = makeFakeD1({
      users: [makeUser(2, "bob")],
      projects: [
        {
          id: "target",
          name: "T",
          org_id: null,
          created_by: 99,
          archived_at: null,
        },
        {
          id: "source",
          name: "S",
          org_id: null,
          created_by: 99,
          archived_at: null,
        },
      ],
      project_members: [
        {
          project_id: "target",
          user_id: 2,
          role_level: 400, // contributor — below 500
          granted_by: 99,
          granted_at: new Date().toISOString(),
        },
      ],
    })
    const jwt = await frontierJwt("bob")
    const res = await app.request(
      "/api/v2/projects/target/link-source",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sourceProjectId: "source" }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(403)
  })

  it("404s on unknown source projects", async () => {
    const db = makeFakeD1({
      users: [makeUser(1, "alice")],
      projects: [
        {
          id: "target",
          name: "T",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
      ],
    })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/projects/target/link-source",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sourceProjectId: "ghost" }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(404)
  })

  it("rejects self-loops with 400", async () => {
    const db = makeFakeD1({
      users: [makeUser(1, "alice")],
      projects: [
        {
          id: "p1",
          name: "P1",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
      ],
    })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/projects/p1/link-source",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sourceProjectId: "p1" }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(400)
  })

  it("detects transitive cycles (A→B→A)", async () => {
    // B already points at A. Now trying to link A→B should cycle.
    const db = makeFakeD1({
      users: [makeUser(1, "alice")],
      projects: [
        {
          id: "A",
          name: "A",
          org_id: null,
          created_by: 1,
          archived_at: null,
          source_project_id: null,
        },
        {
          id: "B",
          name: "B",
          org_id: null,
          created_by: 1,
          archived_at: null,
          source_project_id: "A",
        },
      ],
    })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/projects/A/link-source",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sourceProjectId: "B" }),
      },
      makeEnv(db),
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/cycle/i)
  })
})

describe("POST /api/v2/projects/:projectId/detach-source", () => {
  it("clears source_project_id and bursts source.cell.commit per upstream source cell", async () => {
    const db = makeFakeD1({
      users: [makeUser(1, "alice")],
      projects: [
        {
          id: "target",
          name: "T",
          org_id: null,
          created_by: 1,
          archived_at: null,
          source_project_id: "source",
        },
        {
          id: "source",
          name: "S",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
      ],
      cells: [
        {
          project_id: "source",
          file_id: "f1",
          cell_id: "c1",
          side: "source",
          value: "alpha",
          value_html: null,
        },
        {
          project_id: "source",
          file_id: "f1",
          cell_id: "c2",
          side: "source",
          value: "beta",
          value_html: "<p>beta</p>",
        },
        // Unrelated target row in upstream — should NOT be snapshotted.
        {
          project_id: "source",
          file_id: "f1",
          cell_id: "c1",
          side: "target",
          value: "should not appear",
          value_html: null,
        },
      ],
    })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/projects/target/detach-source",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
      },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      projectId: string
      previousSourceProjectId: string
      snapshottedCellCount: number
    }
    expect(body).toMatchObject({
      projectId: "target",
      previousSourceProjectId: "source",
      snapshottedCellCount: 2,
    })

    const target = db._tables().projects.find((p) => p.id === "target")
    expect(target?.source_project_id).toBeNull()

    const events = db._tables().events
    // 1 project.link-source + 2 source.cell.create snapshots.
    expect(events.filter((e) => e.kind === "project.link-source")).toHaveLength(1)
    const burst = events.filter((e) => e.kind === "source.cell.create")
    expect(burst).toHaveLength(2)
    expect(burst.every((e) => e.project_id === "target")).toBe(true)
    expect(burst.map((e) => JSON.parse(e.payload).value).sort()).toEqual([
      "alpha",
      "beta",
    ])
  })

  it("409s when not linked", async () => {
    const db = makeFakeD1({
      users: [makeUser(1, "alice")],
      projects: [
        {
          id: "p1",
          name: "P1",
          org_id: null,
          created_by: 1,
          archived_at: null,
          source_project_id: null,
        },
      ],
    })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/projects/p1/detach-source",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${jwt}` },
      },
      makeEnv(db),
    )
    expect(res.status).toBe(409)
  })
})

describe("GET /api/v2/projects/:projectId/downstreams", () => {
  it("returns ids of projects pointing at :projectId", async () => {
    const db = makeFakeD1({
      users: [makeUser(1, "alice")],
      projects: [
        {
          id: "source",
          name: "S",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
        {
          id: "t1",
          name: "T1",
          org_id: null,
          created_by: 1,
          archived_at: null,
          source_project_id: "source",
        },
        {
          id: "t2",
          name: "T2",
          org_id: null,
          created_by: 1,
          archived_at: null,
          source_project_id: "source",
        },
        {
          id: "unrelated",
          name: "U",
          org_id: null,
          created_by: 1,
          archived_at: null,
          source_project_id: null,
        },
      ],
    })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/projects/source/downstreams",
      { headers: { Authorization: `Bearer ${jwt}` } },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { downstreams: string[] }
    expect(body.downstreams.sort()).toEqual(["t1", "t2"])
  })
})

describe("DELETE /api/v2/projects/:projectId", () => {
  it("blocks delete when downstreams exist", async () => {
    const db = makeFakeD1({
      users: [makeUser(1, "alice")],
      projects: [
        {
          id: "source",
          name: "S",
          org_id: null,
          created_by: 1,
          archived_at: null,
        },
        {
          id: "target",
          name: "T",
          org_id: null,
          created_by: 1,
          archived_at: null,
          source_project_id: "source",
        },
      ],
    })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/projects/source",
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${jwt}` },
      },
      makeEnv(db),
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; downstreams: string[] }
    expect(body.downstreams).toEqual(["target"])
    // Source NOT deleted.
    expect(db._tables().projects.find((p) => p.id === "source")).toBeDefined()
  })

  it("deletes a leaf (no downstreams) when caller is owner", async () => {
    const db = makeFakeD1({
      users: [makeUser(1, "alice")],
      projects: [
        {
          id: "leaf",
          name: "L",
          org_id: null,
          created_by: 1, // owner via creator
          archived_at: null,
        },
      ],
    })
    const jwt = await frontierJwt("alice")
    const res = await app.request(
      "/api/v2/projects/leaf",
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${jwt}` },
      },
      makeEnv(db),
    )
    expect(res.status).toBe(200)
    expect(db._tables().projects.find((p) => p.id === "leaf")).toBeUndefined()
  })

  it("403s non-owners", async () => {
    const db = makeFakeD1({
      users: [makeUser(2, "bob")],
      projects: [
        {
          id: "leaf",
          name: "L",
          org_id: null,
          created_by: 99,
          archived_at: null,
        },
      ],
      project_members: [
        {
          project_id: "leaf",
          user_id: 2,
          role_level: 600, // maintainer — not enough
          granted_by: 99,
          granted_at: new Date().toISOString(),
        },
      ],
    })
    const jwt = await frontierJwt("bob")
    const res = await app.request(
      "/api/v2/projects/leaf",
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${jwt}` },
      },
      makeEnv(db),
    )
    expect(res.status).toBe(403)
  })
})
