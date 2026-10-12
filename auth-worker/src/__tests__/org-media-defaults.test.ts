// AQU-1768 — org defaults for the media settings (timing lock, track editing,
// who may add or remove lines, audio self-validation, the audio validation
// floor). The org sets a default; a project may set its own; a project that
// sets none follows the org. Modelled on org-validation-defaults.test.ts.
//
// The sync-worker gates (timing lock, track editing, audio validation) are
// pinned in sync-worker/src/__tests__/media-org-defaults.test.ts. This file
// pins the org route, the project settings response, and the one gate
// auth-worker owns: staging an agent's add/remove-line proposal.

import { env } from "cloudflare:test"
import { describe, it, expect, vi, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { stageEvents, type EmitStageContext } from "../lib/agent/emit-stage"
import { AliasMap } from "../lib/agent/compress"

afterEach(() => {
  vi.restoreAllMocks()
})

async function seed() {
  await seedUser(1, "olive") // org owner
  await seedUser(2, "mara")  // org maintainer
  await seedUser(3, "pete")  // project lead, no org role
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1,1,700,1), (1,2,600,1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, '{}', 0, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO projects (id, name, org_id, created_by) VALUES
       ('p-over','Genesis',1,1), ('p-inherit','Exodus',1,1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_settings (project_id, settings, version) VALUES
       ('p-over', ?, 3),
       ('p-inherit', ?, 1)`,
  ).bind(
    JSON.stringify({ timingLocked: true, cellEditingFloor: "none", allowSelfValidationAudio: true }),
    JSON.stringify({ sourceLanguage: "en" }),
  ).run()
}

const patchOrg = async (who: string, settings: Record<string, unknown>, ifMatchVersion = 0) =>
  app.request(
    "/api/v2/orgs/1/settings",
    {
      method: "PATCH",
      headers: authHeader(await jwtFor(who)),
      body: JSON.stringify({ settings, ifMatchVersion }),
    },
    env,
  )

const getOrg = async (who: string) =>
  app.request("/api/v2/orgs/1/settings", { headers: authHeader(await jwtFor(who)) }, env)

const storedProject = async (projectId: string) =>
  JSON.parse(
    (await env.AQUILLA_PG.prepare("SELECT settings FROM project_settings WHERE project_id = ?")
      .bind(projectId).first<{ settings: string }>())!.settings,
  ) as Record<string, unknown>

describe("AQU-1768: org media defaults — the org route", () => {
  it("rejects values the readers would not accept", async () => {
    await seed()
    const bad: Record<string, unknown>[] = [
      { timingLocked: "false" },
      { allowTrackEditing: 1 },
      { cellEditingFloor: "owner" },
      { allowSelfValidationAudio: null },
      { validationRoleFloorAudio: "contributor" },
    ]
    for (const settings of bad) {
      expect((await patchOrg("mara", settings)).status, JSON.stringify(settings)).toBe(400)
    }
  })

  it("a maintainer may set them", async () => {
    await seed()
    const res = await patchOrg("mara", {
      timingLocked: false,
      allowTrackEditing: true,
      cellEditingFloor: "project_lead",
      allowSelfValidationAudio: false,
      validationRoleFloorAudio: "maintainer",
    })
    expect(res.status).toBe(200)
  })

  it("reports how many projects set their own value for each", async () => {
    await seed()
    const body = (await (await getOrg("mara")).json()) as {
      mediaDefaultOverrides: Record<string, number>
    }
    expect(body.mediaDefaultOverrides).toEqual({
      timingLocked: 1,
      allowTrackEditing: 0,
      cellEditingFloor: 1,
      allowSelfValidationAudio: 1,
      validationRoleFloorAudio: 0,
    })
  })

  it("reset clears one key's project overrides and leaves the others", async () => {
    await seed()
    const res = await app.request(
      "/api/v2/orgs/1/settings/timing-locked/reset-project-overrides",
      { method: "POST", headers: authHeader(await jwtFor("mara")) },
      env,
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { cleared: number }).cleared).toBe(1)
    const stored = await storedProject("p-over")
    expect(stored.timingLocked).toBeUndefined()
    expect(stored.cellEditingFloor).toBe("none")
    expect(stored.allowSelfValidationAudio).toBe(true)
  })

  it("reset is maintainer work", async () => {
    await seed()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1,3,500,1)",
    ).run()
    const res = await app.request(
      "/api/v2/orgs/1/settings/cell-editing-floor/reset-project-overrides",
      { method: "POST", headers: authHeader(await jwtFor("pete")) },
      env,
    )
    expect(res.status).toBe(403)
  })
})

describe("AQU-1768: the project settings response", () => {
  it("carries the org's media defaults, valid values only", async () => {
    await seed()
    await patchOrg("mara", { timingLocked: false, validationRoleFloorAudio: "project_lead" })
    // A hand-edited typo on the org blob never reaches the page as a default.
    await env.AQUILLA_PG.prepare(
      `UPDATE org_settings SET settings = ((settings::jsonb) || '{"allowTrackEditing":"yes"}'::jsonb)::text WHERE org_id = 1`,
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p-inherit', 3, 500, 1)",
    ).run()
    const res = await app.request(
      "/api/v2/projects/p-inherit/settings",
      { headers: authHeader(await jwtFor("pete")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { orgMediaDefaults: Record<string, unknown> }
    expect(body.orgMediaDefaults).toEqual({ timingLocked: false, validationRoleFloorAudio: "project_lead" })
  })
})

// ── The agent's add/remove-line gate (emit-stage) ─────────────────────────

const PROJECT = "77777777-7777-4777-8777-777777777777"
const FILE = "88888888-8888-4888-8888-888888888888"

function ctx(roleLevel: number): EmitStageContext {
  return {
    runId: "99999999-9999-4999-8999-999999999999",
    projectId: PROJECT,
    roleLevel,
    lane: "",
    aliases: new AliasMap(),
  }
}

async function seedAgentProject(orgTier: string | null, projectTier: string | null | undefined) {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (9, 'Agent org', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'P', 9, 1)",
  ).bind(PROJECT).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version) VALUES (9, ?, 1)",
  ).bind(JSON.stringify(orgTier ? { cellEditingFloor: orgTier } : {})).run()
  if (projectTier !== undefined) {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings) VALUES (?, ?)",
    ).bind(PROJECT, JSON.stringify(projectTier ? { cellEditingFloor: projectTier } : {})).run()
  }
}

const addLine = (roleLevel: number) =>
  stageEvents(
    env.AQUILLA_PG,
    [{ kind: "source.cell.create", fileId: FILE, payload: { value: "x" } }],
    ctx(roleLevel),
  )

describe("AQU-1768: the agent's add/remove-line gate follows the org default", () => {
  it("applies the org's tier when the project sets none", async () => {
    // Maintainer, so the refusal below is the tier's and not the static
    // project-lead floor on source.cell.create.
    await seedAgentProject("maintainer", null)
    expect((await addLine(600)).proposal).not.toBeNull()
    const low = await addLine(500)
    expect(low.proposal).toBeNull()
    expect(low.modelVerdictBlock).toContain("role too low to add or remove cells")
  })

  it("also follows the org when the project has no settings row at all", async () => {
    await seedAgentProject("project_lead", undefined)
    expect((await addLine(500)).proposal).not.toBeNull()
  })

  it("the project's own explicit 'nobody' wins over the org's tier", async () => {
    await seedAgentProject("contributor", "none")
    const result = await addLine(700)
    expect(result.proposal).toBeNull()
    expect(result.modelVerdictBlock).toContain("not enabled for this project")
  })

  it("nobody, with nothing set anywhere", async () => {
    await seedAgentProject(null, null)
    expect((await addLine(700)).proposal).toBeNull()
  })
})
