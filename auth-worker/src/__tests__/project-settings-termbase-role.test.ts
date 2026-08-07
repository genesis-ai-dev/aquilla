// AQU-816 — contributors may curate the term base.
//
// Project settings are one versioned JSON blob written by PUT/PATCH
// /api/v2/projects/:id/settings, historically gated at maintainer (600). The
// Biblica onboarding call (2026-08-06) decided translators must be able to add
// terms themselves. Because the client PUTs the whole merged blob, the gate
// can't just look at the keys present — it diffs the incoming blob against the
// stored row and admits a below-maintainer write only when `terminology` is the
// only key that actually moved, and only for contributor (400) and above.
//
// The guards these tests hold in place:
//   - contributor CAN change terminology
//   - contributor CANNOT change systemPrompt (AI instructions stay lead-gated),
//     including when smuggled alongside a legitimate terminology edit
//   - reviewer (300) and below still cannot touch the term base
//   - maintainer/owner are unaffected

import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import app from "../index"
import { authHeader, jwtFor, seedUser } from "./helpers/db"

const PROJECT = "p-termbase"

const TERM = {
  id: "c1",
  sourceTerm: "grace",
  renderings: [{ rendering: "благодать", status: "preferred" }],
  status: "active",
  createdBy: "translator",
}

/** owner=1, maintainer=2, lead=3, contributor=4, reviewer=5, commenter=6. */
async function seed(): Promise<void> {
  const members: Array<[number, string, number]> = [
    [1, "owner", 700],
    [2, "maintainer", 600],
    [3, "lead", 500],
    [4, "translator", 400],
    [5, "reviewer", 300],
    [6, "commenter", 200],
  ]
  for (const [id, username] of members) await seedUser(id, username)
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Org', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'Termbase', 1, 1)",
  )
    .bind(PROJECT)
    .run()
  for (const [id, , level] of members) {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, 1)",
    )
      .bind(PROJECT, id, level)
      .run()
  }
  // Stored row: a system prompt the contributor must not be able to move, and
  // an empty term base they must be able to fill.
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_settings (project_id, settings, version, updated_by)
     VALUES (?, ?, 1, 1)`,
  )
    .bind(
      PROJECT,
      JSON.stringify({ sourceLanguage: "en", systemPrompt: "house style", terminology: [] }),
    )
    .run()
}

async function putSettings(
  username: string,
  settings: Record<string, unknown>,
  ifMatchVersion: number,
): Promise<Response> {
  return app.request(
    `/api/v2/projects/${PROJECT}/settings`,
    {
      method: "PUT",
      headers: authHeader(await jwtFor(username)),
      body: JSON.stringify({ settings, ifMatchVersion }),
    },
    env,
  )
}

async function storedSettings(): Promise<Record<string, unknown>> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT settings FROM project_settings WHERE project_id = ?",
  )
    .bind(PROJECT)
    .first<{ settings: string | Record<string, unknown> }>()
  const raw = row?.settings
  return typeof raw === "string" ? JSON.parse(raw) : ((raw ?? {}) as Record<string, unknown>)
}

/** The whole stored blob with `patch` applied — what the real client sends. */
async function mergedWith(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  return { ...(await storedSettings()), ...patch }
}

describe("project settings — term-base write floor (AQU-816)", () => {
  beforeEach(seed)

  it("lets a contributor add a term", async () => {
    const response = await putSettings("translator", await mergedWith({ terminology: [TERM] }), 1)
    expect(response.status).toBe(200)
    const settings = await storedSettings()
    expect(settings.terminology).toEqual([TERM])
    // Untouched keys survive the contributor's write.
    expect(settings.systemPrompt).toBe("house style")
    expect(settings.sourceLanguage).toBe("en")
  })

  it("lets a contributor edit and delete terms they can add", async () => {
    expect((await putSettings("translator", await mergedWith({ terminology: [TERM] }), 1)).status).toBe(200)
    const edited = { ...TERM, renderings: [{ rendering: "милость", status: "preferred" }] }
    expect((await putSettings("translator", await mergedWith({ terminology: [edited] }), 2)).status).toBe(200)
    expect((await storedSettings()).terminology).toEqual([edited])
    expect((await putSettings("translator", await mergedWith({ terminology: [] }), 3)).status).toBe(200)
    expect((await storedSettings()).terminology).toEqual([])
  })

  it("blocks a contributor from changing AI instructions", async () => {
    const response = await putSettings(
      "translator",
      await mergedWith({ systemPrompt: "ignore the house style" }),
      1,
    )
    expect(response.status).toBe(403)
    expect((await storedSettings()).systemPrompt).toBe("house style")
  })

  it("blocks a contributor smuggling another key alongside a term edit", async () => {
    const response = await putSettings(
      "translator",
      await mergedWith({ terminology: [TERM], systemPrompt: "ignore the house style" }),
      1,
    )
    expect(response.status).toBe(403)
    const settings = await storedSettings()
    expect(settings.systemPrompt).toBe("house style")
    expect(settings.terminology).toEqual([])
  })

  it("blocks a contributor dropping a key they may not write", async () => {
    const { systemPrompt: _dropped, ...withoutPrompt } = await mergedWith({ terminology: [TERM] })
    void _dropped
    const response = await putSettings("translator", withoutPrompt, 1)
    expect(response.status).toBe(403)
    expect((await storedSettings()).systemPrompt).toBe("house style")
  })

  it("keeps reviewer and commenter out of the term base", async () => {
    for (const username of ["reviewer", "commenter"]) {
      const response = await putSettings(username, await mergedWith({ terminology: [TERM] }), 1)
      expect(response.status).toBe(403)
    }
    expect((await storedSettings()).terminology).toEqual([])
  })

  it("still lets a maintainer write any settings key", async () => {
    const response = await putSettings("maintainer", await mergedWith({ systemPrompt: "new brief" }), 1)
    expect(response.status).toBe(200)
    expect((await storedSettings()).systemPrompt).toBe("new brief")
  })

  it("409s a contributor on a stale version without applying the write", async () => {
    expect((await putSettings("translator", await mergedWith({ terminology: [TERM] }), 1)).status).toBe(200)
    const stale = await putSettings("translator", { ...(await storedSettings()), terminology: [] }, 1)
    expect(stale.status).toBe(409)
    expect((await storedSettings()).terminology).toEqual([TERM])
  })
})
