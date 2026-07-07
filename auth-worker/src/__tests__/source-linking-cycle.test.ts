// FRO-477: cycle rejection in a 3-hop chain.
//
// chainContains (source-linking.ts) walks the prospective source's OWN
// source_project_id chain upstream looking for the project that's trying to
// link. This test proves the real user-facing shape: A -> B -> C already
// linked (a genuine translation chain, English -> French -> Chaluba), then
// an attempt to link C back to A (closing the loop) must be rejected with
// 409 — no dedicated chainContains/cycle test existed before this issue.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seedProjectWithLead(projectId: string, name: string, leadUserId: number): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)")
    .bind(projectId, name, leadUserId)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, 500, ?)",
  )
    .bind(projectId, leadUserId, leadUserId)
    .run()
}

describe("POST /:projectId/link-source — 3-hop cycle rejection", () => {
  it("rejects linking A to C when the chain is already A -> B -> C (A would become its own descendant)", async () => {
    await seedUser(1, "lead")
    await seedProjectWithLead("proj-a-english", "English", 1)
    await seedProjectWithLead("proj-b-french", "French", 1)
    await seedProjectWithLead("proj-c-chaluba", "Chaluba", 1)

    const jwt = await jwtFor("lead")

    // Build the real chain: B -> A, then C -> B.
    const linkBA = await app.request(
      "/api/v2/projects/proj-b-french/link-source",
      { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ sourceProjectId: "proj-a-english", mode: "live", consumes: "source" }) },
      env,
    )
    expect(linkBA.status).toBe(200)

    const linkCB = await app.request(
      "/api/v2/projects/proj-c-chaluba/link-source",
      { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ sourceProjectId: "proj-b-french", mode: "live", consumes: "target", gate: "validated" }) },
      env,
    )
    expect(linkCB.status).toBe(200)

    // Now attempt to close the loop: link A to C (A's prospective source
    // would be C, whose chain already climbs C -> B -> A).
    const cycleAttempt = await app.request(
      "/api/v2/projects/proj-a-english/link-source",
      { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ sourceProjectId: "proj-c-chaluba" }) },
      env,
    )
    expect(cycleAttempt.status).toBe(409)
    const body = await cycleAttempt.json() as { error: string }
    expect(body.error).toMatch(/cycle/i)

    // A's link state must be unchanged (still no source_project_id) —
    // the rejected attempt must not have partially applied.
    const row = await env.AQUILLA_PG.prepare("SELECT source_project_id FROM projects WHERE id = ?")
      .bind("proj-a-english")
      .first<{ source_project_id: string | null }>()
    expect(row?.source_project_id).toBeNull()
  })

  it("still allows a NON-cyclic new link once the chain exists (sanity: rejection is specific to the cycle, not chains in general)", async () => {
    await seedUser(2, "lead2")
    await seedProjectWithLead("proj-x", "X", 2)
    await seedProjectWithLead("proj-y", "Y", 2)
    await seedProjectWithLead("proj-z", "Z", 2)

    const jwt = await jwtFor("lead2")
    const linkYX = await app.request(
      "/api/v2/projects/proj-y/link-source",
      { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ sourceProjectId: "proj-x", mode: "live" }) },
      env,
    )
    expect(linkYX.status).toBe(200)

    // Z -> X is NOT a cycle (Z and Y are siblings, both consuming X) —
    // must succeed.
    const linkZX = await app.request(
      "/api/v2/projects/proj-z/link-source",
      { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ sourceProjectId: "proj-x", mode: "live" }) },
      env,
    )
    expect(linkZX.status).toBe(200)
  })
})
