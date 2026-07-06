// FRO-478: GET /api/v2/projects and GET /api/v2/projects/:id must surface
// the FRO-476 link state (sourceProjectId + mode/consumes/gate/cursor on the
// single-project route). Before this fix neither route selected these
// columns at all — `CloudProjectSummary`/`ProjectStateResponse` declared
// `sourceProjectId` and `SourceLinkSection` gated its render on it, but the
// field was always undefined in practice because the server never sent it.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seed() {
  await seedUser(1, "wendi") // owner (700)
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('upstream-p', 'Upstream', 1, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO projects (id, name, org_id, created_by,
       source_project_id, source_link_mode, source_link_consumes, source_link_gate, source_link_cursor)
     VALUES ('downstream-p', 'Downstream', 1, 1, 'upstream-p', 'live', 'source', 'validated', 42)`,
  ).run()
}

describe("GET /api/v2/projects/:id — link metadata", () => {
  it("surfaces sourceProjectId + mode/consumes/gate/cursor for a linked project", async () => {
    await seed()
    const jwt = await jwtFor("wendi")
    const res = await app.request("/api/v2/projects/downstream-p", { headers: authHeader(jwt) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      sourceProjectId: string | null
      sourceLinkMode: string | null
      sourceLinkConsumes: string | null
      sourceLinkGate: string | null
      sourceLinkCursor: number | null
    }
    expect(body.sourceProjectId).toBe("upstream-p")
    expect(body.sourceLinkMode).toBe("live")
    expect(body.sourceLinkConsumes).toBe("source")
    expect(body.sourceLinkGate).toBe("validated")
    expect(body.sourceLinkCursor).toBe(42)
  })

  it("returns null link fields for a self-contained (unlinked) project", async () => {
    await seed()
    const jwt = await jwtFor("wendi")
    const res = await app.request("/api/v2/projects/upstream-p", { headers: authHeader(jwt) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sourceProjectId: string | null }
    expect(body.sourceProjectId).toBeNull()
  })
})

describe("GET /api/v2/projects — link metadata on the list endpoint", () => {
  it("includes sourceProjectId per project in the list", async () => {
    await seed()
    const jwt = await jwtFor("wendi")
    const res = await app.request("/api/v2/projects", { headers: authHeader(jwt) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string; sourceProjectId: string | null }> }
    const downstream = body.projects.find((p) => p.id === "downstream-p")
    const upstream = body.projects.find((p) => p.id === "upstream-p")
    expect(downstream?.sourceProjectId).toBe("upstream-p")
    expect(upstream?.sourceProjectId).toBeNull()
  })
})
