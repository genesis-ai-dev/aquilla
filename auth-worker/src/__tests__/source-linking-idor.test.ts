// [Pen test] AQU authz review — cross-tenant source-linking IDOR.
//
// POST /:projectId/link-source only checked the caller's role on the
// DOWNSTREAM project. It never checked whether the caller has any
// relationship to `sourceProjectId` — it only confirmed that project exists.
// Because any authenticated user can own(700) a brand-new project of their
// own, this let an attacker link their own project's source to ANY other
// project id on the platform and either clone-snapshot or live-mirror its
// source cells into a project they control, with no invite or interaction
// from the victim project's owner. This test proves the exploit is closed:
// linking to a project the caller has no access to must be rejected, and
// no source content may be copied.

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

describe("POST /:projectId/link-source — cross-tenant IDOR", () => {
  it("rejects linking to an upstream project the caller has no access to", async () => {
    await seedUser(1, "victim-lead")
    await seedUser(2, "attacker")
    await seedProjectWithLead("victim-project", "Victim's Private Bible", 1)

    // Attacker owns their own project (role 700 via created_by) but has
    // ZERO relationship to victim-project.
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES ('attacker-project', 'Attacker Project', 2)")
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('attacker-project', 2, 700, 2)",
    ).run()

    const attackerJwt = await jwtFor("attacker")

    const res = await app.request(
      "/api/v2/projects/attacker-project/link-source",
      {
        method: "POST",
        headers: authHeader(attackerJwt),
        body: JSON.stringify({ sourceProjectId: "victim-project", mode: "clone" }),
      },
      env,
    )

    expect(res.status).toBe(403)

    const row = await env.AQUILLA_PG.prepare("SELECT source_project_id FROM projects WHERE id = ?")
      .bind("attacker-project")
      .first<{ source_project_id: string | null }>()
    expect(row?.source_project_id).toBeNull()
  })

  it("still allows linking when the caller has access to both projects (no regression)", async () => {
    await seedUser(3, "lead3")
    await seedProjectWithLead("shared-downstream", "Downstream", 3)
    await seedProjectWithLead("shared-upstream", "Upstream", 3)

    const jwt = await jwtFor("lead3")
    const res = await app.request(
      "/api/v2/projects/shared-downstream/link-source",
      {
        method: "POST",
        headers: authHeader(jwt),
        body: JSON.stringify({ sourceProjectId: "shared-upstream", mode: "clone" }),
      },
      env,
    )
    expect(res.status).toBe(200)
  })
})
