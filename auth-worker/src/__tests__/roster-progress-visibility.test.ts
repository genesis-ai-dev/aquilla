// AQU-485: roster + member-progress visibility permission tests.
//
// Verifies:
//   1. Default (no org policy configured): rosterViewMinRole falls back to
//      MAINTAINER (600) — the acceptance criterion is "safe for sensitive
//      teams out of the box," so the default itself hides the roster from
//      contributor/viewer callers even with zero configuration. This is a
//      deliberate behavior change from pre-AQU-485 (see the superseded
//      assertion in permission-semantics.test.ts).
//   2. Explicitly configuring rosterViewMinRole=maintainer(600) hides the org
//      members list AND the project members list from a below-floor caller,
//      returning a distinct 403 that does not leak the roster or its count.
//   3. A caller AT or ABOVE the floor still sees the roster unchanged.
//   4. rosterViewMinRole and memberProgressViewMinRole are independent keys
//      — setting one does not affect the other's write-validated value.
//   5. Only org owners (700) may change either floor; maintainers get 403.
//   6. Invalid floor values are rejected with 400.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seedOrgAndProject() {
  await seedUser(1, "wendi")   // org owner (700)
  await seedUser(2, "anna")    // org maintainer (600)
  await seedUser(3, "tom")     // org contributor (400)
  await seedUser(4, "vera")    // org viewer (100)

  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Sensitive Team', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES
      (1, 1, 700, 1),
      (1, 2, 600, 1),
      (1, 3, 400, 1),
      (1, 4, 100, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj1', 'Gospel of John', 1, 1)",
  ).run()
}

async function setOrgSettings(settings: Record<string, unknown>) {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, ?, 1, 1)`,
  )
    .bind(JSON.stringify(settings))
    .run()
}

const getOrgMembers = async (username: string) =>
  app.request("/api/v2/orgs/1/members", { headers: authHeader(await jwtFor(username)) }, env)

const getProjectMembers = async (username: string) =>
  app.request(
    "/api/v2/projects/proj1/members",
    { headers: authHeader(await jwtFor(username)) },
    env,
  )

const patchOrgSettings = async (
  username: string,
  settings: Record<string, unknown>,
  ifMatchVersion: number,
) =>
  app.request(
    "/api/v2/orgs/1/settings",
    {
      method: "PATCH",
      headers: authHeader(await jwtFor(username)),
      body: JSON.stringify({ settings, ifMatchVersion }),
    },
    env,
  )

describe("roster visibility — default (no org policy configured)", () => {
  it("org members route: default floor (maintainer) hides the roster from a contributor", async () => {
    await seedOrgAndProject()
    const res = await getOrgMembers("tom")
    expect(res.status).toBe(403)
    const body = (await res.json()) as { rosterHidden?: boolean }
    expect(body.rosterHidden).toBe(true)
  })

  it("org members route: default floor still shows the roster to a maintainer", async () => {
    await seedOrgAndProject()
    const res = await getOrgMembers("anna")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { members: unknown[] }
    expect(body.members.length).toBe(4)
  })

  it("project members route: default floor hides the roster from a viewer", async () => {
    await seedOrgAndProject()
    const res = await getProjectMembers("vera")
    expect(res.status).toBe(403)
  })

  it("project members route: default floor still shows the roster to an owner", async () => {
    await seedOrgAndProject()
    const res = await getProjectMembers("wendi")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { members: unknown[] }
    expect(Array.isArray(body.members)).toBe(true)
  })
})

describe("roster visibility — rosterViewMinRole=maintainer(600) configured", () => {
  it("hides the org roster (and count) from a contributor (400)", async () => {
    await seedOrgAndProject()
    await setOrgSettings({ rosterViewMinRole: 600 })
    const res = await getOrgMembers("tom")
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string; rosterHidden?: boolean; members?: unknown }
    expect(body.rosterHidden).toBe(true)
    // The response must not leak the roster or its size under any key.
    expect(body.members).toBeUndefined()
  })

  it("hides the org roster from a viewer (100)", async () => {
    await seedOrgAndProject()
    await setOrgSettings({ rosterViewMinRole: 600 })
    const res = await getOrgMembers("vera")
    expect(res.status).toBe(403)
  })

  it("still shows the roster to a maintainer (600) — at the floor", async () => {
    await seedOrgAndProject()
    await setOrgSettings({ rosterViewMinRole: 600 })
    const res = await getOrgMembers("anna")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { members: unknown[] }
    expect(body.members.length).toBe(4)
  })

  it("still shows the roster to an owner (700) — above the floor", async () => {
    await seedOrgAndProject()
    await setOrgSettings({ rosterViewMinRole: 600 })
    const res = await getOrgMembers("wendi")
    expect(res.status).toBe(200)
  })

  it("hides the PROJECT roster from a below-floor contributor who has project access", async () => {
    await seedOrgAndProject()
    // AQU-435: tom's org contributor (400) role no longer reaches the project
    // by itself — give him a direct grant so he hits the roster gate, not the
    // project-access 403.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 3, 400, 1)",
    ).run()
    await setOrgSettings({ rosterViewMinRole: 600 })
    const res = await getProjectMembers("tom")
    expect(res.status).toBe(403)
    const body = (await res.json()) as { rosterHidden?: boolean }
    expect(body.rosterHidden).toBe(true)
  })

  it("still shows the PROJECT roster to a maintainer", async () => {
    await seedOrgAndProject()
    await setOrgSettings({ rosterViewMinRole: 600 })
    const res = await getProjectMembers("anna")
    expect(res.status).toBe(200)
  })
})

describe("roster + member-progress floors are independent", () => {
  it("roster visible while memberProgressViewMinRole stays at its own (higher) floor", async () => {
    await seedOrgAndProject()
    // Open the roster to everyone, but keep progress locked to owner-only.
    await setOrgSettings({ rosterViewMinRole: 100, memberProgressViewMinRole: 700 })
    const rosterRes = await getOrgMembers("tom")
    expect(rosterRes.status).toBe(200)
    // No dedicated progress route exists yet (AQU-498) — assert the stored
    // config values themselves are independent via the settings GET.
    const settingsRes = await app.request(
      "/api/v2/orgs/1/settings",
      { headers: authHeader(await jwtFor("tom")) },
      env,
    )
    const settingsBody = (await settingsRes.json()) as { settings: Record<string, unknown> }
    expect(settingsBody.settings.rosterViewMinRole).toBe(100)
    expect(settingsBody.settings.memberProgressViewMinRole).toBe(700)
  })

  it("setting rosterViewMinRole does not implicitly change memberProgressViewMinRole", async () => {
    await seedOrgAndProject()
    await setOrgSettings({ memberProgressViewMinRole: 500 })
    const patchRes = await patchOrgSettings(
      "wendi",
      { memberProgressViewMinRole: 500, rosterViewMinRole: 600 },
      1,
    )
    expect(patchRes.status).toBe(200)
    const body = (await patchRes.json()) as { settings: Record<string, unknown> }
    expect(body.settings.rosterViewMinRole).toBe(600)
    expect(body.settings.memberProgressViewMinRole).toBe(500)
  })
})

describe("write gate — only org owners can change the new permission-policy keys", () => {
  it("403s when a maintainer (600) tries to set rosterViewMinRole", async () => {
    await seedOrgAndProject()
    await setOrgSettings({})
    const res = await patchOrgSettings("anna", { rosterViewMinRole: 700 }, 1)
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/rosterViewMinRole/)
  })

  it("403s when a maintainer (600) tries to set memberProgressViewMinRole", async () => {
    await seedOrgAndProject()
    await setOrgSettings({})
    const res = await patchOrgSettings("anna", { memberProgressViewMinRole: 700 }, 1)
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/memberProgressViewMinRole/)
  })

  it("200s when an owner (700) sets both new floors to valid values", async () => {
    await seedOrgAndProject()
    await setOrgSettings({})
    const res = await patchOrgSettings(
      "wendi",
      { rosterViewMinRole: 500, memberProgressViewMinRole: 700 },
      1,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings: Record<string, unknown> }
    expect(body.settings.rosterViewMinRole).toBe(500)
    expect(body.settings.memberProgressViewMinRole).toBe(700)
  })

  it("400s when rosterViewMinRole is an invalid value (garbage string)", async () => {
    await seedOrgAndProject()
    await setOrgSettings({})
    const res = await patchOrgSettings("wendi", { rosterViewMinRole: "maintainer" }, 1)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/rosterViewMinRole/)
  })

  it("400s when memberProgressViewMinRole is out of range", async () => {
    await seedOrgAndProject()
    await setOrgSettings({})
    const res = await patchOrgSettings("wendi", { memberProgressViewMinRole: 9999 }, 1)
    expect(res.status).toBe(400)
  })

  it("an unchanged echo of an existing floor by a maintainer still succeeds", async () => {
    // Read-modify-write pattern: a maintainer's whole-object PATCH that
    // echoes back the existing rosterViewMinRole unchanged must not 403 —
    // otherwise setting a floor locks maintainers out of ALL settings writes.
    await seedOrgAndProject()
    await setOrgSettings({ rosterViewMinRole: 600 })
    const res = await patchOrgSettings(
      "anna",
      { rosterViewMinRole: 600, someOtherKey: "value" },
      1,
    )
    expect(res.status).toBe(200)
  })
})
