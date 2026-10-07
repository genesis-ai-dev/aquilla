// AQU-1075: a downstream copies the settings its maintainer asked for when the
// upstream saves, and that copy walks the chain. The lane is
// source_link_lane_id: NULL is the former default lane (before AQU-1616 fills
// it) and a stored id must be that upstream's lane. A field the downstream
// detached is not written, so the project below it does not move either.

import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { loadProjectSettings, updateProjectSettingsShared } from "../../../db/shared/projects"
import { emptyInheritedFromLink } from "../../../src/lib/sync/inherited-settings"

const A = "proj-1075-a"
const B = "proj-1075-b"
const C = "proj-1075-c"
const CLONE = "proj-1075-clone"
const FOREIGN = "proj-1075-foreign"
const OTHER = "proj-1075-other"
const LANE_B = "lane-1075-b"
const LANE_OTHER = "lane-1075-other"

async function seedProject(id: string, name: string): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, 1)")
    .bind(id, name)
    .run()
}

async function linkTo(
  id: string,
  upstreamId: string,
  mode: "live" | "clone",
  laneId: string | null,
): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `UPDATE projects
        SET source_project_id = ?, source_link_mode = ?, source_link_consumes = 'target',
            source_link_lane_id = ?
      WHERE id = ?`,
  )
    .bind(upstreamId, mode, laneId, id)
    .run()
}

async function seedLane(id: string, projectId: string, legacyTag: string): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, name, legacy_tag, position)
     VALUES (?, ?, 'target', ?, ?, 1)`,
  )
    .bind(id, projectId, legacyTag, legacyTag)
    .run()
}

async function writeSettings(
  projectId: string,
  settings: Record<string, unknown>,
  propagation = false,
): Promise<void> {
  const current = await loadProjectSettings(env.AQUILLA_PG, projectId)
  const result = await updateProjectSettingsShared(env.AQUILLA_PG, {
    projectId,
    settings,
    ifMatchVersion: current.version,
    updatedBy: 1,
    inheritPropagation: propagation,
  })
  expect(result.status).toBe("ok")
}

async function settingsOf(projectId: string): Promise<Record<string, unknown>> {
  return (await loadProjectSettings(env.AQUILLA_PG, projectId)).settings
}

const receiving = emptyInheritedFromLink()

beforeEach(async () => {
  await seedUser(1, "lead")
  await seedProject(A, "Greek")
  await seedProject(B, "French")
  await seedProject(C, "English")
  await seedProject(CLONE, "Snapshot")
  await seedProject(FOREIGN, "Blocked")
  await seedProject(OTHER, "Elsewhere")
  await seedLane(LANE_B, B, "fr")
  await seedLane(LANE_OTHER, OTHER, "es")
  // B is the pre-backfill shape: the lane column is still NULL, which means
  // the upstream's former default lane. C names B's lane, the post-backfill shape.
  await linkTo(B, A, "live", null)
  await linkTo(C, B, "live", LANE_B)
  await linkTo(CLONE, A, "clone", null)
  await linkTo(FOREIGN, A, "live", LANE_OTHER)
})

describe("inherited settings along a chain (AQU-1075)", () => {
  it("copies A's brief and workflow to B and C, and a detach on B stops both", async () => {
    await writeSettings(A, {
      translationBrief: { summary: "one" },
      systemPrompt: "translate English to French",
      validationCount: 2,
      validationNamedUsers: ["ada"],
      rules: [{ id: "upstream-rule" }],
    }, true)

    const downstream = {
      translationBrief: { summary: "one" },
      systemPrompt: "keep mine",
      validationCount: 2,
      validationNamedUsers: ["bea"],
      rules: [{ id: "local-rule" }],
      inheritedFromLink: receiving,
    }
    await writeSettings(B, downstream, true)
    await writeSettings(C, { ...downstream, systemPrompt: "keep C" }, true)
    await writeSettings(CLONE, { ...downstream, translationBrief: { summary: "snapshot" } }, true)
    await writeSettings(FOREIGN, { ...downstream, translationBrief: { summary: "stuck" } }, true)

    await writeSettings(A, {
      translationBrief: { summary: "two" },
      systemPrompt: "translate English to French, revised",
      validationCount: 4,
      validationNamedUsers: ["ada", "bo"],
      rules: [{ id: "upstream-rule-2" }],
    })

    const b = await settingsOf(B)
    const c = await settingsOf(C)
    expect(b.translationBrief).toEqual({ summary: "two" })
    expect(c.translationBrief).toEqual({ summary: "two" })
    expect(b.validationCount).toBe(4)
    expect(c.validationCount).toBe(4)
    expect(b.systemPrompt).toBe("keep mine")
    expect(c.systemPrompt).toBe("keep C")
    expect(b.validationNamedUsers).toEqual(["bea"])
    expect(b.rules).toEqual([{ id: "local-rule" }])
    expect(c.validationNamedUsers).toEqual(["bea"])
    expect((await settingsOf(CLONE)).translationBrief).toEqual({ summary: "snapshot" })
    expect((await settingsOf(FOREIGN)).translationBrief).toEqual({ summary: "stuck" })

    const detached = {
      ...receiving,
      receive: { ...receiving.receive, translationBrief: false },
      detached: { translationBrief: true },
    }
    const bNow = await settingsOf(B)
    await writeSettings(B, { ...bNow, inheritedFromLink: detached })

    await writeSettings(A, {
      translationBrief: { summary: "three" },
      systemPrompt: "translate English to French, revised",
      validationCount: 4,
      validationNamedUsers: ["ada", "bo"],
      rules: [{ id: "upstream-rule-2" }],
    })

    expect((await settingsOf(B)).translationBrief).toEqual({ summary: "two" })
    expect((await settingsOf(C)).translationBrief).toEqual({ summary: "two" })
  })
})

describe("link creation stores the default choice (AQU-1075)", () => {
  it("copies the brief and does not copy AI instructions when the request omits the choice", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ranSync: true }), { status: 200 }),
    )
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, 1, 500, 1)",
    )
      .bind(B)
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, 1, 100, 1)",
    )
      .bind(A)
      .run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO lanes (id, project_id, role, name, legacy_tag, position)
       VALUES ('lane-1075-a', ?, 'target', 'French', '', 1)`,
    )
      .bind(A)
      .run()
    await writeSettings(A, {
      translationBrief: { summary: "from A" },
      systemPrompt: "name the language pair",
    }, true)
    // B was linked in beforeEach. Detach it so this request is a new link.
    await env.AQUILLA_PG.prepare(
      `UPDATE projects
          SET source_project_id = NULL, source_link_mode = NULL, source_link_consumes = NULL,
              source_link_lane_id = NULL
        WHERE id = ?`,
    )
      .bind(B)
      .run()

    const res = await app.request(
      `/api/v2/projects/${B}/link-source`,
      {
        method: "POST",
        headers: authHeader(await jwtFor("lead")),
        body: JSON.stringify({ sourceProjectId: A, mode: "live", consumes: "target", laneId: "lane-1075-a" }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const stored = await settingsOf(B)
    expect(stored.translationBrief).toEqual({ summary: "from A" })
    expect(stored.systemPrompt).toBeUndefined()
    const choice = stored.inheritedFromLink as { receive: { systemPrompt: boolean; translationBrief: boolean } }
    expect(choice.receive.translationBrief).toBe(true)
    expect(choice.receive.systemPrompt).toBe(false)
  })
})
