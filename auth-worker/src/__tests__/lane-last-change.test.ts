// AQU-1464 — GET /api/v2/projects/:projectId/lanes/:laneId/last-change.
//
// The archive confirmation asks this route one question before a PM locks a
// lane: is anyone still working in here? Archiving became a hard write-lock
// (AQU-1462 / AQU-1463), so a wrong answer here interrupts a translator
// mid-session — or, the other way round, scares a PM off a dormant lane.
//
// The two failure modes worth guarding, in order of severity:
//   1. NOT lane-specific. Reporting the whole project's newest edit would make
//      every lane look busy and the feature useless. Source rows are the sharp
//      edge: they are lane-agnostic (shared by every lane), so counting them
//      would give every lane the same date.
//   2. Leaking a member's name and activity time below the archive floor. The
//      route reuses archiving's own `languageEditMinRole` gate, so whoever may
//      archive may read this, and nobody else.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const ES_LANE = "lane-es"
const DEFAULT_LANE = "lane-default"

/**
 * One project with a default target lane and an extra "Spanish" lane.
 * `dan` is a maintainer (600, at the default language-edit floor); `carla` is a
 * contributor (400, below it).
 */
async function seed(): Promise<void> {
  await seedUser(1, "owner")
  await seedUser(2, "carla") // contributor — below the archive floor
  await seedUser(3, "dan") // maintainer — may archive, so may read this
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, created_by) VALUES ('p1', 'Lanes', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_members (project_id, user_id, role_level)
     VALUES ('p1', 2, 400), ('p1', 3, 600)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ('p1', ?, 1, 1)",
  )
    .bind(JSON.stringify({ sourceLanguage: "en", targetLanguage: "fr", targetLanes: ["es"] }))
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
     VALUES (?, 'p1', 'target', 'French', 'fr', '', 0),
            (?, 'p1', 'target', 'Spanish', 'es', 'es', 1),
            ('lane-src', 'p1', 'source', 'English', 'en', NULL, 0)`,
  )
    .bind(DEFAULT_LANE, ES_LANE)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO files (id, project_id, name, event_id) VALUES ('f1', 'p1', 'GEN', 'e-f1')",
  ).run()
}

async function insertCell(opts: {
  cellId: string
  side: "source" | "target"
  laneId: string
  lastEditor: string | null
  lastEditAt: number
  fileId?: string
}): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells
       (project_id, file_id, cell_id, side, value, event_id, last_editor, last_edit_at, lane_id)
     VALUES ('p1', ?, ?, ?, 'text', ?, ?, ?, ?)`,
  )
    .bind(
      opts.fileId ?? "f1",
      opts.cellId,
      opts.side,
      `e-${opts.cellId}-${opts.side}`,
      opts.lastEditor,
      opts.lastEditAt,
      opts.laneId,
    )
    .run()
}

async function lastChange(username: string, laneId = ES_LANE): Promise<Response> {
  return app.request(
    `/api/v2/projects/p1/lanes/${laneId}/last-change`,
    { headers: authHeader(await jwtFor(username)) },
    env,
  )
}

type Body = { lastChange: { at: number; by: string | null } | null }

describe("AQU-1464 — a lane's last change", () => {
  it("reports the newest target edit in the lane, with the editing member", async () => {
    await seed()
    await insertCell({ cellId: "GEN 1:1", side: "target", laneId: ES_LANE, lastEditor: "carla", lastEditAt: 1_700_000_000_000 })
    await insertCell({ cellId: "GEN 1:2", side: "target", laneId: ES_LANE, lastEditor: "dan", lastEditAt: 1_800_000_000_000 })
    const res = await lastChange("dan")
    expect(res.status).toBe(200)
    const body = (await res.json()) as Body
    expect(body.lastChange).toEqual({ at: 1_800_000_000_000, by: "dan" })
  })

  it("ignores another lane's edits — the answer is per lane, not per project", async () => {
    await seed()
    await insertCell({ cellId: "GEN 1:1", side: "target", laneId: ES_LANE, lastEditor: "carla", lastEditAt: 1_700_000_000_000 })
    // A much newer edit in the DEFAULT lane must not move Spanish's date.
    await insertCell({ cellId: "GEN 1:1", side: "target", laneId: DEFAULT_LANE, lastEditor: "dan", lastEditAt: 1_900_000_000_000 })
    const body = (await (await lastChange("dan")).json()) as Body
    expect(body.lastChange).toEqual({ at: 1_700_000_000_000, by: "carla" })
    // ...and the default lane reports its own, so neither is reading the other.
    const defaultBody = (await (await lastChange("dan", DEFAULT_LANE)).json()) as Body
    expect(defaultBody.lastChange).toEqual({ at: 1_900_000_000_000, by: "dan" })
  })

  it("ignores source rows, which belong to no target lane", async () => {
    await seed()
    // Source rows are lane-agnostic: the projection files them under the SOURCE
    // lane (see sync-worker/src/events/lane-id-sql.ts), never under a target
    // lane, and `cells_pkey` is (project, file, cell, lane) — so a re-import
    // stamping every source row far more recently than anyone translated must
    // not make a dormant target lane look busy.
    await insertCell({ cellId: "GEN 1:1", side: "target", laneId: ES_LANE, lastEditor: "carla", lastEditAt: 1_700_000_000_000 })
    await insertCell({ cellId: "GEN 1:1", side: "source", laneId: "lane-src", lastEditor: "owner", lastEditAt: 1_950_000_000_000 })
    const body = (await (await lastChange("dan")).json()) as Body
    expect(body.lastChange).toEqual({ at: 1_700_000_000_000, by: "carla" })
  })

  it("returns null for a lane nobody has translated in yet", async () => {
    await seed()
    const res = await lastChange("dan")
    expect(res.status).toBe(200)
    expect(((await res.json()) as Body).lastChange).toBeNull()
  })

  it("does not count cells in a deleted file — those are unreachable work", async () => {
    await seed()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO files (id, project_id, name, event_id, deleted_at) VALUES ('f2', 'p1', 'EXO', 'e-f2', 123)",
    ).run()
    await insertCell({ cellId: "EXO 1:1", side: "target", laneId: ES_LANE, lastEditor: "dan", lastEditAt: 1_900_000_000_000, fileId: "f2" })
    await insertCell({ cellId: "GEN 1:1", side: "target", laneId: ES_LANE, lastEditor: "carla", lastEditAt: 1_700_000_000_000 })
    const body = (await (await lastChange("dan")).json()) as Body
    expect(body.lastChange).toEqual({ at: 1_700_000_000_000, by: "carla" })
  })

  it("keeps the date to itself when the edit records no editor", async () => {
    await seed()
    await insertCell({ cellId: "GEN 1:1", side: "target", laneId: ES_LANE, lastEditor: null, lastEditAt: 1_700_000_000_000 })
    const body = (await (await lastChange("dan")).json()) as Body
    expect(body.lastChange).toEqual({ at: 1_700_000_000_000, by: null })
  })

  it("refuses a contributor — the same floor that guards archiving", async () => {
    await seed()
    await insertCell({ cellId: "GEN 1:1", side: "target", laneId: ES_LANE, lastEditor: "carla", lastEditAt: 1_700_000_000_000 })
    const res = await lastChange("carla")
    expect(res.status).toBe(403)
    // No member name or timestamp may appear in a refusal body.
    expect(await res.text()).not.toMatch(/carla|1700000000000/)
  })

  it("404s an unknown lane rather than passing it off as never edited", async () => {
    await seed()
    const res = await lastChange("dan", "lane-nope")
    expect(res.status).toBe(404)
  })

  it("404s the source lane — only target lanes are archivable", async () => {
    await seed()
    const res = await lastChange("dan", "lane-src")
    expect(res.status).toBe(404)
  })
})
