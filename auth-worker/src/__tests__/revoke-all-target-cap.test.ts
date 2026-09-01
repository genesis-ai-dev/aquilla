// [Pen test 2026-08-25] Authorization & access control review.
//
// POST /:projectId/members/:userId/revoke-all performs the exact same
// mutation as DELETE /:projectId/members/:userId (DELETE FROM
// project_members WHERE project_id = ? AND user_id = ?), but was missing the
// AQU-285 (F-B6) target-level cap that the DELETE route enforces: "a caller
// below OWNER cannot act on a member whose current role is >= their own."
//
// Exploit (pre-fix): a MAINTAINER (600) could POST .../revoke-all against an
// OWNER (700)'s userId and strip their direct project_members row — something
// the DELETE endpoint explicitly refuses. If the owner's access was purely a
// direct grant (no surviving org/group/creator path), this de-facto demoted
// or locked out the project's owner from a Maintainer-level account.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seedProjectWithOwnerAndMaintainer(): Promise<void> {
  await seedUser(1, "owner")
  await seedUser(2, "maintainer")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-cap', 'Cap', NULL, 1)",
  ).run()
  // Both are DIRECT (override) grants so revoke-all has a row to act on.
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-cap', 1, 700, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-cap', 2, 600, 1)",
  ).run()
}

describe("[Pen test 2026-08-25] revoke-all target-level cap (AQU-285 F-B6 parity)", () => {
  it("refuses a MAINTAINER revoking an OWNER's direct grant", async () => {
    await seedProjectWithOwnerAndMaintainer()

    const res = await app.request(
      "/api/v2/projects/proj-cap/members/1/revoke-all",
      { method: "POST", headers: authHeader(await jwtFor("maintainer")), body: "{}" },
      env,
    )
    expect(res.status).toBe(403)

    const row = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM project_members WHERE project_id = 'proj-cap' AND user_id = 1",
    ).first<{ role_level: number }>()
    expect(row?.role_level).toBe(700)
  })

  it("still allows an OWNER to revoke-all a MAINTAINER's direct grant", async () => {
    await seedProjectWithOwnerAndMaintainer()

    const res = await app.request(
      "/api/v2/projects/proj-cap/members/2/revoke-all",
      { method: "POST", headers: authHeader(await jwtFor("owner")), body: "{}" },
      env,
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { removed: boolean }).removed).toBe(true)

    const row = await env.AQUILLA_PG.prepare(
      "SELECT 1 FROM project_members WHERE project_id = 'proj-cap' AND user_id = 2",
    ).first()
    expect(row).toBeNull()
  })

  it("still allows a MAINTAINER to revoke-all a lower-role member", async () => {
    await seedProjectWithOwnerAndMaintainer()
    await seedUser(3, "contributor")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-cap', 3, 400, 1)",
    ).run()

    const res = await app.request(
      "/api/v2/projects/proj-cap/members/3/revoke-all",
      { method: "POST", headers: authHeader(await jwtFor("maintainer")), body: "{}" },
      env,
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { removed: boolean }).removed).toBe(true)
  })
})
