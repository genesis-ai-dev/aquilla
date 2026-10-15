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

  it("project members ?minRole=600: a below-floor project member still sees only Maintainer+", async () => {
    await seedOrgAndProject()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 3, 400, 1)",
    ).run()
    const res = await app.request(
      "/api/v2/projects/proj1/members?minRole=600",
      { headers: authHeader(await jwtFor("tom")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { members: Array<{ username: string; role: { level: number } }> }
    expect(body.members.map((m) => m.username).sort()).toEqual(["anna", "wendi"])
    expect(body.members.every((m) => m.role.level >= 600)).toBe(true)
  })

  it("project members ?minRole=400 does not bypass the roster hide", async () => {
    await seedOrgAndProject()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 3, 400, 1)",
    ).run()
    const res = await app.request(
      "/api/v2/projects/proj1/members?minRole=400",
      { headers: authHeader(await jwtFor("tom")) },
      env,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { rosterHidden?: boolean; members?: unknown }
    expect(body.rosterHidden).toBe(true)
    expect(body.members).toBeUndefined()
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

// ── AQU-1771: a project's own floors — stricter than the org, never looser ──

describe("project visibility floors — stricter than the org, never looser (AQU-1771)", () => {
  async function setProjectSettings(projectId: string, settings: Record<string, unknown>) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (?, ?, 1, 1)
       ON CONFLICT (project_id) DO UPDATE SET settings = EXCLUDED.settings`,
    )
      .bind(projectId, JSON.stringify(settings))
      .run()
  }

  async function grant(projectId: string, userId: number, level: number) {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, 1)",
    )
      .bind(projectId, userId, level)
      .run()
  }

  const get = async (username: string, path: string) =>
    app.request(path, { headers: authHeader(await jwtFor(username)) }, env)

  it("a project raising the member list to owners hides it from a maintainer the org floor admits", async () => {
    await seedOrgAndProject()
    await setProjectSettings("proj1", { rosterViewMinRole: 700 })
    const res = await getProjectMembers("anna")
    expect(res.status).toBe(403)
    expect(((await res.json()) as { rosterHidden?: boolean }).rosterHidden).toBe(true)
    expect((await getProjectMembers("wendi")).status).toBe(200)
    // The ORG's member list is the org's alone; a project setting does not touch it.
    expect((await getOrgMembers("anna")).status).toBe(200)
  })

  it("a project raising member progress to owners refuses the Team card and plan reads to a maintainer", async () => {
    await seedOrgAndProject()
    await setProjectSettings("proj1", { memberProgressViewMinRole: 700 })
    for (const path of [
      "/api/v2/projects/proj1/assignments/all",
      "/api/v2/projects/proj1/assignments/unit?fileId=f1",
      "/api/v2/projects/proj1/assignments/units",
    ]) {
      expect((await get("anna", path)).status, path).toBe(403)
      expect((await get("wendi", path)).status, path).toBe(200)
    }
  })

  it("a stored project value below the org's floor has no effect", async () => {
    await seedOrgAndProject()
    await grant("proj1", 3, 400)
    await setOrgSettings({ rosterViewMinRole: 600, memberProgressViewMinRole: 600 })
    await setProjectSettings("proj1", { rosterViewMinRole: 100, memberProgressViewMinRole: 100 })
    expect((await getProjectMembers("tom")).status).toBe(403)
    expect((await get("tom", "/api/v2/projects/proj1/assignments/all")).status).toBe(403)
    expect((await get("tom", "/api/v2/projects/proj1/assignments/units")).status).toBe(403)
  })

  it("the org's assign-work carve-out (AQU-1308) never undercuts a project's stricter member list", async () => {
    await seedOrgAndProject()
    await seedUser(5, "rita")
    await grant("proj1", 5, 300) // reviewer
    // The org lets reviewers assign work, so they may read the project roster
    // the assignee picker is built from — even though its roster floor is 400.
    await setOrgSettings({ rosterViewMinRole: 400, assignmentMinRole: 300 })
    expect((await getProjectMembers("rita")).status).toBe(200)

    // This project closes its member list to project leads and up. The
    // carve-out belongs to the org's value and must not reopen it.
    await setProjectSettings("proj1", { rosterViewMinRole: 500 })
    expect((await getProjectMembers("rita")).status).toBe(403)
    expect((await getProjectMembers("anna")).status).toBe(200)
    const mentions = (await (await get("rita", "/api/v2/projects/proj1/mention-candidates")).json()) as {
      restricted?: boolean
    }
    expect(mentions.restricted).toBe(true)
  })

  it("a project value equal to the org's is inert and keeps the carve-out", async () => {
    await seedOrgAndProject()
    await seedUser(5, "lena")
    await grant("proj1", 5, 500) // project lead
    await setOrgSettings({ rosterViewMinRole: 600 })
    await setProjectSettings("proj1", { rosterViewMinRole: 600 })
    // Default assignment floor (project lead) reads the project roster.
    expect((await getProjectMembers("lena")).status).toBe(200)
  })

  it("the org Team workload hides the rows of a project stricter than the caller", async () => {
    await seedOrgAndProject()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj2', 'Acts', 1, 1)",
    ).run()
    await grant("proj1", 3, 400)
    await grant("proj2", 3, 400)
    await env.AQUILLA_PG.prepare(
      `INSERT INTO assignments (assignment_id, project_id, assignee_user_id, scope_kind, scope_label, cells_total, created_by, created_at)
       VALUES ('as-1', 'proj1', 3, 'books', 'John', 1, 1, 1000), ('as-2', 'proj2', 3, 'books', 'Acts', 1, 1, 1100)`,
    ).run()
    await setOrgSettings({ rosterViewMinRole: 400, memberProgressViewMinRole: 400 })
    await setProjectSettings("proj2", { memberProgressViewMinRole: 600 })

    const ids = async (username: string) => {
      const res = await get(username, "/api/v2/orgs/1/assignments/workload")
      expect(res.status).toBe(200)
      return ((await res.json()) as { assignments: Array<{ assignmentId: string }> }).assignments
        .map((a) => a.assignmentId)
        .sort()
    }
    expect(await ids("tom")).toEqual(["as-1"])
    expect(await ids("anna")).toEqual(["as-1", "as-2"])
  })

  it("the access inspector applies a project's stricter member list", async () => {
    await seedOrgAndProject()
    await grant("proj1", 3, 400)
    await setOrgSettings({ rosterViewMinRole: 400 })
    const inspect = () => get("tom", "/api/v2/users/1/access?from=project:proj1")
    expect((await inspect()).status).toBe(200)
    await setProjectSettings("proj1", { rosterViewMinRole: 600 })
    expect((await inspect()).status).toBe(403)
  })
})

describe("saving a project's own visibility floors (AQU-1771)", () => {
  async function seedSettings(project: Record<string, unknown>, org: Record<string, unknown> = {}) {
    await seedOrgAndProject()
    await setOrgSettings(org)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ('proj1', ?, 1, 1)",
    )
      .bind(JSON.stringify(project))
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 3, 400, 1)",
    ).run()
  }

  const patchProject = async (username: string, settings: Record<string, unknown>) =>
    app.request(
      "/api/v2/projects/proj1/settings",
      {
        method: "PATCH",
        headers: authHeader(await jwtFor(username)),
        body: JSON.stringify({ settings, ifMatchVersion: 1 }),
      },
      env,
    )

  it("lets a project maintainer make either floor stricter", async () => {
    await seedSettings({})
    const res = await patchProject("anna", { rosterViewMinRole: 700, memberProgressViewMinRole: 700 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      visibilityFloors: Record<string, { org: number; project: number | null; effective: number }>
    }
    expect(body.visibilityFloors.rosterViewMinRole).toEqual({ org: 600, project: 700, effective: 700 })
  })

  it("refuses a value below the org's floor, and says why", async () => {
    await seedSettings({}, { rosterViewMinRole: 600 })
    const res = await patchProject("wendi", { rosterViewMinRole: 400 })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/below the organization's setting \(600\)/)
    expect(body.error).toMatch(/only make who sees the member list stricter/)
  })

  it("refuses a value that is not a role level", async () => {
    await seedSettings({})
    expect((await patchProject("wendi", { memberProgressViewMinRole: 650 })).status).toBe(400)
    expect((await patchProject("wendi", { memberProgressViewMinRole: "owner" })).status).toBe(400)
  })

  it("refuses a contributor, like every other maintainer-gated setting", async () => {
    await seedSettings({})
    expect((await patchProject("tom", { rosterViewMinRole: 700 })).status).toBe(403)
  })

  it("lets a stored value the org has since overtaken ride along on an unrelated save", async () => {
    // Stored when the org was at 400; the org has since raised it to 600.
    await seedSettings({ rosterViewMinRole: 500 }, { rosterViewMinRole: 600 })
    const res = await patchProject("wendi", { rosterViewMinRole: 500, systemPrompt: "Be brief." })
    expect(res.status).toBe(200)
  })

  // Sam, 2026-10-13: "Owners only" binds maintainers. A stored project value
  // may be lowered or removed only by someone at or above it.
  const storedProject = async () => {
    const row = await env.AQUILLA_PG.prepare(
      "SELECT settings FROM project_settings WHERE project_id = 'proj1'",
    ).first<{ settings: string }>()
    return JSON.parse(row?.settings ?? "{}") as Record<string, unknown>
  }

  it("refuses a maintainer lowering an owner's Owners-only value", async () => {
    await seedSettings({ rosterViewMinRole: 700 })
    const res = await patchProject("anna", { rosterViewMinRole: 600 })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code?: string; required?: { roleLevel: number }; error: string }
    expect(body.code).toBe("role_required")
    expect(body.required?.roleLevel).toBe(700)
    expect(body.error).toMatch(/owner or higher is required to make who sees the member list on this project less strict/)
    expect((await storedProject()).rosterViewMinRole).toBe(700)
  })

  it("refuses a maintainer removing it, whether by null or by leaving it out of the save", async () => {
    await seedSettings({ memberProgressViewMinRole: 700, systemPrompt: "Be brief." })
    expect((await patchProject("anna", { memberProgressViewMinRole: null, systemPrompt: "Be brief." })).status).toBe(403)
    // The client saves the whole object; a save without the key removes it.
    expect((await patchProject("anna", { systemPrompt: "Be terse." })).status).toBe(403)
    expect(await storedProject()).toEqual({ memberProgressViewMinRole: 700, systemPrompt: "Be brief." })
  })

  it("lets an owner lower it and remove it", async () => {
    await seedSettings({ rosterViewMinRole: 700 })
    const lowered = await patchProject("wendi", { rosterViewMinRole: 600 })
    expect(lowered.status).toBe(200)
    const removed = await app.request(
      "/api/v2/projects/proj1/settings",
      {
        method: "PATCH",
        headers: authHeader(await jwtFor("wendi")),
        body: JSON.stringify({ settings: {}, ifMatchVersion: 2 }),
      },
      env,
    )
    expect(removed.status).toBe(200)
    expect((await storedProject()).rosterViewMinRole).toBeUndefined()
  })

  it("lets a maintainer raise it, and loosen a value at their own level", async () => {
    await seedSettings({ rosterViewMinRole: 600 }, { rosterViewMinRole: 400 })
    // Lower their own Maintainers value to Project leads: allowed (600 ≥ 600).
    const lowered = await patchProject("anna", { rosterViewMinRole: 500 })
    expect(lowered.status).toBe(200)
    const raised = await app.request(
      "/api/v2/projects/proj1/settings",
      {
        method: "PATCH",
        headers: authHeader(await jwtFor("anna")),
        body: JSON.stringify({ settings: { rosterViewMinRole: 700 }, ifMatchVersion: 2 }),
      },
      env,
    )
    expect(raised.status).toBe(200)
    expect((await storedProject()).rosterViewMinRole).toBe(700)
  })

  it("carries the org's policy to a project-only member who cannot read the org's settings", async () => {
    await seedSettings({ rosterViewMinRole: 700 }, {
      memberProgressViewMinRole: 500,
      autoPropagateRepetitions: false,
      allowSelfAssignment: true,
      assignmentMinRole: 400,
      exportMinRole: 400,
    })
    await seedUser(6, "pat")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 6, 400, 1)",
    ).run()
    const orgRes = await app.request("/api/v2/orgs/1/settings", { headers: authHeader(await jwtFor("pat")) }, env)
    expect(orgRes.status).toBe(403)

    const res = await app.request("/api/v2/projects/proj1/settings", { headers: authHeader(await jwtFor("pat")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      orgPolicy: Record<string, unknown>
      visibilityFloors: Record<string, { org: number; project: number | null; effective: number }>
    }
    expect(body.orgPolicy).toEqual({
      rosterViewMinRole: 600,
      memberProgressViewMinRole: 500,
      allowSelfAssignment: true,
      allowScopedLaneAssignment: false,
      assignmentMinRole: 400,
      autoPropagateRepetitions: false,
      exportMinRole: 400,
    })
    expect(body.visibilityFloors).toEqual({
      rosterViewMinRole: { org: 600, project: 700, effective: 700 },
      memberProgressViewMinRole: { org: 500, project: null, effective: 500 },
    })
  })
})

describe("counting the org's stricter projects (AQU-1771)", () => {
  async function project(id: string, settings: Record<string, unknown>, archived = false) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO projects (id, name, org_id, created_by, archived_at) VALUES (?, ?, 1, 1, ${archived ? "now()" : "NULL"})`,
    )
      .bind(id, id)
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (?, ?, 1, 1)",
    )
      .bind(id, JSON.stringify(settings))
      .run()
  }

  const counts = async (username: string) =>
    app.request("/api/v2/orgs/1/settings/visibility-overrides", { headers: authHeader(await jwtFor(username)) }, env)

  it("counts only live projects whose own value is stricter than the org's", async () => {
    await seedOrgAndProject()
    await setOrgSettings({ rosterViewMinRole: 500 })
    await project("a", { rosterViewMinRole: 600, memberProgressViewMinRole: 700 })
    await project("b", { rosterViewMinRole: 500 }) // equal to the org's: follows it
    await project("c", { rosterViewMinRole: 400, memberProgressViewMinRole: 600 }) // below / equal: inert
    await project("d", { rosterViewMinRole: 700 }, true) // archived
    await project("e", { systemPrompt: "nothing about visibility" })
    const res = await counts("tom")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rosterViewMinRole: 1, memberProgressViewMinRole: 1 })
  })

  it("refuses someone outside the org", async () => {
    await seedOrgAndProject()
    await seedUser(9, "stranger")
    expect((await counts("stranger")).status).toBe(403)
  })
})

// AQU-1771: the org's members matrix lists many projects' rosters at once. A
// project's roster is in it only when the caller could read it from GET
// /projects/:id/members — the same floor, project override included.
describe("members matrix follows each project's member-list floor (AQU-1771)", () => {
  const matrix = async (username: string) => {
    const res = await app.request("/api/v2/orgs/1/members-matrix", { headers: authHeader(await jwtFor(username)) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ projectId: string; members: Array<{ username: string }> }> }
    return new Map(body.projects.map((p) => [p.projectId, p.members.map((m) => m.username).sort()]))
  }

  async function grant(projectId: string, userId: number, level: number) {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, 1)",
    )
      .bind(projectId, userId, level)
      .run()
  }

  it("gives a contributor no roster for a project whose member list is closed to them", async () => {
    await seedOrgAndProject()
    await grant("proj1", 3, 400)
    // Default floor (Maintainer): /projects/proj1/members refuses tom...
    expect((await getProjectMembers("tom")).status).toBe(403)
    // ...so the matrix must not hand him the same roster.
    expect((await matrix("tom")).has("proj1")).toBe(false)
  })

  it("gives a viewer no roster either, and the roster once the org opens the list to viewers", async () => {
    await seedOrgAndProject()
    await grant("proj1", 4, 100)
    expect((await matrix("vera")).has("proj1")).toBe(false)
    await setOrgSettings({ rosterViewMinRole: 100 })
    expect((await getProjectMembers("vera")).status).toBe(200)
    expect((await matrix("vera")).get("proj1")).toContain("wendi")
  })

  it("gives an org maintainer no roster for a project whose member list is Owners only", async () => {
    await seedOrgAndProject()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ('proj1', ?, 1, 1)",
    )
      .bind(JSON.stringify({ rosterViewMinRole: 700 }))
      .run()
    expect((await getProjectMembers("anna")).status).toBe(403)
    expect((await matrix("anna")).has("proj1")).toBe(false)
    // An owner still sees it.
    expect((await matrix("wendi")).has("proj1")).toBe(true)
  })

  it("keeps the assigners' carve-out on the org's value: a reviewer who may assign work gets the roster", async () => {
    await seedOrgAndProject()
    await seedUser(5, "rita")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 5, 300, 1)",
    ).run()
    await grant("proj1", 5, 300)
    await setOrgSettings({ rosterViewMinRole: 400, assignmentMinRole: 300 })
    expect((await matrix("rita")).has("proj1")).toBe(true)
  })
})

// AQU-1771: an org MAINTAINER used to skip a project's member-list floor on
// every access-inspection surface. A project closed to owners must stay
// closed to them there too, as it is on GET …/members.
describe("access inspection follows a project's Owners-only member list (AQU-1771)", () => {
  async function ownersOnlyProject() {
    await seedOrgAndProject()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 3, 400, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ('proj1', ?, 1, 1)",
    )
      .bind(JSON.stringify({ rosterViewMinRole: 700 }))
      .run()
  }
  const get = async (username: string, path: string) =>
    app.request(path, { headers: authHeader(await jwtFor(username)) }, env)

  it("the member inspector refuses an org maintainer the project's view, not an owner", async () => {
    await ownersOnlyProject()
    expect((await get("anna", "/api/v2/users/3/access?from=project:proj1")).status).toBe(403)
    expect((await get("wendi", "/api/v2/users/3/access?from=project:proj1")).status).toBe(200)
  })

  it("People & access leaves the project and its grantees out for an org maintainer", async () => {
    await ownersOnlyProject()
    const mentions = (text: string) => text.includes("proj1") || text.includes("Gospel of John")
    const maintainerView = await get("anna", "/api/v2/orgs/1/access")
    expect(maintainerView.status).toBe(200)
    expect(mentions(await maintainerView.text())).toBe(false)
    const ownerView = await get("wendi", "/api/v2/orgs/1/access")
    expect(mentions(await ownerView.text())).toBe(true)
  })

  it("a member's access breakdown leaves the project out for an org maintainer", async () => {
    await ownersOnlyProject()
    const projectsOf = async (username: string) =>
      ((await (await get(username, "/api/v2/orgs/1/members/3/access")).json()) as {
        projects: Array<{ projectId: string }>
      }).projects.map((p) => p.projectId)
    expect(await projectsOf("anna")).toEqual([])
    expect(await projectsOf("wendi")).toEqual(["proj1"])
  })

  it("an org maintainer still sees a project that follows the org's default", async () => {
    await seedOrgAndProject()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj1', 3, 400, 1)",
    ).run()
    expect((await get("anna", "/api/v2/users/3/access?from=project:proj1")).status).toBe(200)
    const projects = ((await (await get("anna", "/api/v2/orgs/1/members/3/access")).json()) as {
      projects: Array<{ projectId: string }>
    }).projects
    expect(projects.map((p) => p.projectId)).toEqual(["proj1"])
  })
})
