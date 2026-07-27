// AQU-487 — Remove the per-project default permission (over-permission
// footgun).
//
// Prior to this ticket, the members/share UI carried a `defaultRole` control
// that read as if it set a project-wide default applied to every member —
// changing it looked like it could silently overwrite an individual
// member's intentional role (e.g. "set the project default to reviewer"
// making everybody a reviewer). Investigation found no such path actually
// persisted server-side: `resolveProjectRole` (project-permissions.ts) has
// always resolved strictly via max-wins over four explicit, per-member
// grant paths (direct override, group, org, creator) with no fifth
// "project default" fallback. The UI control was renamed
// (`newMemberDefaultRole`) to make clear it only seeds the "role to grant"
// picker for a brand-new add and is never persisted.
//
// These tests encode the WHY, not just the WHAT: they prove (1) a member's
// effective role comes solely from their own explicit grant — changing one
// member's role can never change another's — and (2) there is no hidden
// project-level default that a previously-"defaulted" member could lose on
// deploy. Since no default was ever persisted per-member, there is nothing
// to backfill; a member who only ever had an org-wide or group grant keeps
// that grant untouched by any other member's role change (the migration-
// safety guarantee the ticket calls for).

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seedOrgAndProject() {
  await seedUser(1, "owner_user")
  await seedUser(2, "member_a")
  await seedUser(3, "member_b")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'DefaultRoleOrg', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-default', 'DefaultRoleProject', 1, 1)",
  ).run()
}

async function getRole(username: string) {
  const res = await app.request(
    "/api/v2/projects/proj-default",
    { headers: authHeader(await jwtFor(username)) },
    env,
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { role: { level: number; source: string } }
  return body.role
}

describe("AQU-487: no project-wide default role — effective role is explicit-grant-only", () => {
  it("changing member A's role to reviewer(300) never changes member B's independently-granted role", async () => {
    await seedOrgAndProject()
    // Both members get explicit direct grants at different levels.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-default', 2, 400, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-default', 3, 600, 1)",
    ).run()

    expect((await getRole("member_a")).level).toBe(400)
    expect((await getRole("member_b")).level).toBe(600)

    // Simulate "setting the project default to reviewer" for member A only —
    // this is just changing A's OWN explicit grant, not a project-wide knob.
    const res = await app.request(
      "/api/v2/projects/proj-default/members",
      {
        method: "POST",
        headers: authHeader(await jwtFor("owner_user")),
        body: JSON.stringify({ username: "member_a", role: 300 }),
      },
      env,
    )
    expect(res.status).toBe(200)

    // Member A's role changed as requested...
    expect((await getRole("member_a")).level).toBe(300)
    // ...but member B's role is completely untouched. If a project-wide
    // default existed, this is exactly where it would leak: any "set
    // default role" action would clobber every member without an explicit
    // override, silently promoting or demoting people who were never
    // touched by this request.
    expect((await getRole("member_b")).level).toBe(600)
  })

  it("resolveProjectRole has no project-level fallback: a member with zero grant paths gets no access, regardless of other members' roles", async () => {
    await seedOrgAndProject()
    await seedUser(4, "no_grant_user")
    // Give member_a a high explicit role.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-default', 2, 600, 1)",
    ).run()

    // A user with genuinely zero grant paths (no override, no group, no org
    // membership, not the creator) must be denied — proving there is no
    // fifth "project default" path that would grant them some baseline
    // role just because OTHER members have one.
    const res = await app.request(
      "/api/v2/projects/proj-default",
      { headers: authHeader(await jwtFor("no_grant_user")) },
      env,
    )
    expect(res.status).toBe(403)
  })

  it("migration safety: a member who only ever held an org-wide grant (the closest thing to a shared 'default') keeps that grant untouched when another member's direct override changes", async () => {
    // This encodes the ticket's migration-safety acceptance criterion:
    // "existing previously-defaulted members keep a sensible explicit role
    // — no silent access change." Since no project-wide default was ever
    // persisted per-member in this codebase, there is no row to backfill;
    // the closest analogue to "a member who relied on some shared setting"
    // is one who relies solely on the org-wide grant (itself an explicit,
    // per-member-via-org-membership grant, not a blanket project default).
    // This test proves that grant survives independent of any other
    // member's direct-override changes — i.e. deploying this change cannot
    // silently strip or alter their access.
    await seedOrgAndProject()
    await seedUser(5, "org_only_member")
    // AQU-435: the org-wide grant path now starts at maintainer (600); a
    // maintainer is the member who still relies solely on it.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 5, 600, 1)",
    ).run()

    const before = await getRole("org_only_member")
    expect(before.level).toBe(600)
    expect(before.source).toBe("org")

    // Another member gets a brand-new direct override at a different level.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-default', 2, 300, 1)",
    ).run()

    const after = await getRole("org_only_member")
    expect(after.level).toBe(600)
    expect(after.source).toBe("org")
  })
})
