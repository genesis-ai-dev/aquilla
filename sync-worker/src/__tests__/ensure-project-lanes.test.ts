// AQU-1240 slice 6: ensureProjectLanes creates the source + default-target
// rows a new project needs, promotes placeholder names when languages arrive,
// and never overwrites a human rename.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createProjectShared, updateProjectSettingsShared } from "../../../db/shared/projects"
import {
  createTargetLane,
  ensureProjectLanes,
  ensureProjectLaneStmts,
  insertTargetLane,
  isLaneIdCollision,
  listProjectLanes,
  renameTargetLane,
  setTargetLaneArchived,
} from "../../../db/shared/lanes"
import {
  BLANK_LANE_PLACEHOLDER,
  SOURCE_LANE_PLACEHOLDER,
} from "../../../src/lib/lanes/backfill-plan"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const laneIdQueue = vi.hoisted(() => [] as string[])

vi.mock("../../../src/lib/lanes/lane-id", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/lanes/lane-id")>()
  return {
    ...actual,
    newLaneId: () => laneIdQueue.shift() ?? actual.newLaneId(),
  }
})

const PROJECT = "proj-ensure-lanes"

async function lanes(t: TestDb) {
  const r = await t.pg.query<{
    role: string
    name: string
    lang_code: string | null
    legacy_tag: string | null
  }>(
    `SELECT role, name, lang_code, legacy_tag FROM lanes
      WHERE project_id = $1
      ORDER BY role, legacy_tag NULLS FIRST`,
    [PROJECT],
  )
  return r.rows
}

let t: TestDb
beforeEach(async () => {
  laneIdQueue.length = 0
  if (!t) t = await makeTestDb()
  else await t.reset()
})
afterAll(async () => {
  await t?.close()
})

describe("ensureProjectLanes", () => {
  it("creates a source lane and a default target lane from empty settings", async () => {
    await ensureProjectLanes(t.db, PROJECT, { settings: {} })
    expect(await lanes(t)).toEqual([
      {
        role: "source",
        name: SOURCE_LANE_PLACEHOLDER,
        lang_code: null,
        legacy_tag: null,
      },
      {
        role: "target",
        name: BLANK_LANE_PLACEHOLDER,
        lang_code: null,
        legacy_tag: "",
      },
    ])
  })

  it("names lanes from language settings and maps catalog codes", async () => {
    await ensureProjectLanes(t.db, PROJECT, {
      settings: { sourceLanguage: "English", targetLanguage: "Spanish", targetLanes: ["French"] },
    })
    const rows = await lanes(t)
    expect(rows).toEqual([
      { role: "source", name: "English", lang_code: "en", legacy_tag: null },
      { role: "target", name: "Spanish", lang_code: "es", legacy_tag: "" },
      { role: "target", name: "French", lang_code: "fr", legacy_tag: "French" },
    ])
  })

  it("promotes placeholder names when languages arrive later, without changing ids", async () => {
    await ensureProjectLanes(t.db, PROJECT, { settings: {} })
    const before = await t.pg.query<{ id: string; role: string }>(
      `SELECT id, role FROM lanes WHERE project_id = $1 ORDER BY role`,
      [PROJECT],
    )
    await ensureProjectLanes(t.db, PROJECT, {
      settings: { sourceLanguage: "English", targetLanguage: "Spanish" },
    })
    const after = await t.pg.query<{ id: string; role: string; name: string }>(
      `SELECT id, role, name FROM lanes WHERE project_id = $1 ORDER BY role`,
      [PROJECT],
    )
    expect(after.rows.map((r) => r.id)).toEqual(before.rows.map((r) => r.id))
    expect(after.rows.find((r) => r.role === "source")?.name).toBe("English")
    expect(after.rows.find((r) => r.role === "target")?.name).toBe("Spanish")
  })

  it("does not overwrite a human-renamed lane", async () => {
    await ensureProjectLanes(t.db, PROJECT, { settings: { targetLanguage: "Spanish" } })
    await t.pg.query(
      `UPDATE lanes SET name = 'Draft Spanish' WHERE project_id = $1 AND role = 'target'`,
      [PROJECT],
    )
    await ensureProjectLanes(t.db, PROJECT, {
      settings: { sourceLanguage: "English", targetLanguage: "French" },
    })
    const rows = await lanes(t)
    expect(rows.find((r) => r.role === "target")?.name).toBe("Draft Spanish")
  })

  it("is idempotent: a second call does not duplicate rows", async () => {
    const stmts1 = ensureProjectLaneStmts(t.db, PROJECT, { settings: { targetLanguage: "Spanish" } })
    const stmts2 = ensureProjectLaneStmts(t.db, PROJECT, { settings: { targetLanguage: "Spanish" } })
    await t.db.batch(stmts1)
    await t.db.batch(stmts2)
    expect(await lanes(t)).toHaveLength(2)
  })

  it("assigns 8-hex ids that stay put on re-run, and rejects the same id in another project", async () => {
    await ensureProjectLanes(t.db, PROJECT, { settings: { targetLanguage: "Spanish" } })
    const first = await t.pg.query<{ id: string; role: string }>(
      `SELECT id, role FROM lanes WHERE project_id = $1 ORDER BY role, legacy_tag NULLS FIRST`,
      [PROJECT],
    )
    expect(first.rows.length).toBeGreaterThan(0)
    for (const row of first.rows) {
      expect(row.id).toMatch(/^[0-9a-f]{8}$/)
    }

    const sharedId = first.rows[0]!.id
    const otherProject = "proj-ensure-lanes-other"
    await expect(
      t.pg.query(
        `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
         VALUES ($1, $2, 'source', 'Source', NULL, NULL, 0)`,
        [sharedId, otherProject],
      ),
    ).rejects.toMatchObject({ code: "23505", constraint: "uq_lanes_id" })

    await ensureProjectLanes(t.db, PROJECT, { settings: { targetLanguage: "Spanish" } })
    const again = await t.pg.query<{ id: string }>(
      `SELECT id FROM lanes WHERE project_id = $1 ORDER BY role, legacy_tag NULLS FIRST`,
      [PROJECT],
    )
    expect(again.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id))
  })

  it("retries a lane id that another project already has", async () => {
    const taken = "aabbccdd"
    await t.pg.query(
      `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
       VALUES ($1, 'proj-a', 'source', 'Source', NULL, NULL, 0)`,
      [taken],
    )
    laneIdQueue.push(taken)
    await ensureProjectLanes(t.db, PROJECT, { settings: {} })
    expect(laneIdQueue).not.toContain(taken)

    const rows = await t.pg.query<{ id: string; project_id: string }>(
      `SELECT project_id, id FROM lanes ORDER BY project_id, id`,
    )
    const ours = rows.rows.filter((row) => row.project_id === PROJECT)
    expect(ours).toHaveLength(2)
    for (const row of ours) {
      expect(row.id).not.toBe(taken)
      expect(row.id).toMatch(/^[0-9a-f]{8}$/)
    }
    expect(rows.rows.filter((row) => row.id === taken)).toEqual([
      { project_id: "proj-a", id: taken },
    ])
  })

  it("keeps existing ids when a re-run mints an id this project already has", async () => {
    await ensureProjectLanes(t.db, PROJECT, { settings: {} })
    const before = await t.pg.query<{ id: string }>(
      `SELECT id FROM lanes WHERE project_id = $1 ORDER BY role, legacy_tag NULLS FIRST`,
      [PROJECT],
    )
    laneIdQueue.push(before.rows[0]!.id)
    await ensureProjectLanes(t.db, PROJECT, { settings: {} })
    const after = await t.pg.query<{ id: string }>(
      `SELECT id FROM lanes WHERE project_id = $1 ORDER BY role, legacy_tag NULLS FIRST`,
      [PROJECT],
    )
    expect(after.rows.map((row) => row.id)).toEqual(before.rows.map((row) => row.id))
    expect(await lanes(t)).toHaveLength(2)
  })
})

describe("isLaneIdCollision", () => {
  it("matches the unique index on either driver error shape", () => {
    expect(isLaneIdCollision({ code: "23505", constraint: "uq_lanes_id" })).toBe(true)
    expect(isLaneIdCollision({ code: "23505", constraint_name: "uq_lanes_id" })).toBe(true)
    expect(isLaneIdCollision({
      message: 'duplicate key value violates unique constraint "uq_lanes_id"',
    })).toBe(true)
    expect(isLaneIdCollision({
      cause: { code: "23505", constraint_name: "uq_lanes_id" },
    })).toBe(true)
    expect(isLaneIdCollision({ code: "23505", constraint: "lanes_pkey" })).toBe(false)
    expect(isLaneIdCollision({ code: "23505", constraint: "uq_lanes_project_source" })).toBe(false)
    expect(isLaneIdCollision({ code: "23503", constraint: "uq_lanes_id" })).toBe(false)
  })
})

describe("createTargetLane", () => {
  it("retries a colliding id and uses the new id as the legacy tag", async () => {
    await ensureProjectLanes(t.db, PROJECT, {
      settings: { targetLanguage: "Spanish", targetLanes: ["Yoruba"] },
    })
    const taken = "aabbccdd"
    await t.pg.query(
      `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
       VALUES ($1, 'proj-a', 'source', 'Source', NULL, NULL, 0)`,
      [taken],
    )
    laneIdQueue.push(taken)
    const existing = await listProjectLanes(t.db, PROJECT)
    const created = await createTargetLane(t.db, PROJECT, {
      name: "Yoruba Team",
      language: "Yoruba",
      targetLanguage: "Spanish",
      existing: existing.map((lane) => ({
        id: lane.id,
        name: lane.name,
        legacyTag: lane.legacyTag,
      })),
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.laneId).not.toBe(taken)
    expect(created.legacyTag).toBe(created.laneId)
    const row = await t.pg.query<{ id: string; legacy_tag: string }>(
      `SELECT id, legacy_tag FROM lanes WHERE project_id = $1 AND name = 'Yoruba Team'`,
      [PROJECT],
    )
    expect(row.rows).toEqual([{ id: created.laneId, legacy_tag: created.laneId }])
    const owners = await t.pg.query<{ project_id: string }>(
      `SELECT project_id FROM lanes WHERE id = $1`,
      [taken],
    )
    expect(owners.rows).toEqual([{ project_id: "proj-a" }])
  })
})

describe("createProjectShared seeds lanes atomically", () => {
  it("creates placeholder lanes when no languages are seeded", async () => {
    const { inserted } = await createProjectShared(t.db, {
      projectId: PROJECT,
      name: "P",
      orgId: null,
      createdBy: 1,
    })
    expect(inserted).toBe(true)
    expect(await lanes(t)).toHaveLength(2)
    expect((await lanes(t)).map((r) => r.name).sort()).toEqual(
      [BLANK_LANE_PLACEHOLDER, SOURCE_LANE_PLACEHOLDER].sort(),
    )
  })

  it("retries a colliding lane id without inserting the project twice", async () => {
    const taken = "aabbccdd"
    await t.pg.query(
      `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
       VALUES ($1, 'proj-a', 'source', 'Source', NULL, NULL, 0)`,
      [taken],
    )
    laneIdQueue.push(taken)
    const { inserted } = await createProjectShared(t.db, {
      projectId: PROJECT,
      name: "P",
      orgId: null,
      createdBy: 1,
    })
    expect(inserted).toBe(true)
    const projects = await t.pg.query<{ id: string }>(
      `SELECT id FROM projects WHERE id = $1`,
      [PROJECT],
    )
    expect(projects.rows).toEqual([{ id: PROJECT }])
    const created = await t.pg.query<{ id: string }>(
      `SELECT id FROM lanes WHERE project_id = $1`,
      [PROJECT],
    )
    expect(created.rows.length).toBeGreaterThan(0)
    expect(created.rows.map((row) => row.id)).not.toContain(taken)
  })

  it("names lanes from settingsSeed", async () => {
    await createProjectShared(t.db, {
      projectId: PROJECT,
      name: "P",
      orgId: null,
      createdBy: 1,
      settingsSeed: { sourceLanguage: "English", targetLanguage: "Spanish" },
    })
    const rows = await lanes(t)
    expect(rows.find((r) => r.role === "source")).toMatchObject({ name: "English", lang_code: "en" })
    expect(rows.find((r) => r.role === "target")).toMatchObject({
      name: "Spanish",
      lang_code: "es",
      legacy_tag: "",
    })
  })
})

describe("updateProjectSettingsShared promotes placeholder lanes", () => {
  it("names the default target from the first settings write", async () => {
    await createProjectShared(t.db, {
      projectId: PROJECT,
      name: "P",
      orgId: null,
      createdBy: 1,
    })
    const result = await updateProjectSettingsShared(t.db, {
      projectId: PROJECT,
      settings: { sourceLanguage: "English", targetLanguage: "Spanish", targetLanes: ["French"] },
      ifMatchVersion: 0,
      updatedBy: 1,
    })
    expect(result.status).toBe("ok")
    const rows = await lanes(t)
    expect(rows.find((r) => r.role === "source")?.name).toBe("English")
    expect(rows.find((r) => r.role === "target" && r.legacy_tag === "")?.name).toBe("Spanish")
    expect(rows.find((r) => r.legacy_tag === "French")?.name).toBe("French")
  })
})

describe("rename and archive a target lane", () => {
  it("renames without touching the legacy tag, and refuses a duplicate name", async () => {
    await ensureProjectLanes(t.db, PROJECT, {
      settings: { targetLanguage: "Spanish", targetLanes: ["Yoruba"] },
    })
    const before = await listProjectLanes(t.db, PROJECT)
    const yoruba = before.find((lane) => lane.legacyTag === "Yoruba")
    expect(yoruba).toBeTruthy()
    const renamed = await renameTargetLane(t.db, PROJECT, yoruba!.id, "Yoruba Team")
    expect(renamed.status).toBe("ok")
    if (renamed.status === "ok") {
      expect(renamed.lane.name).toBe("Yoruba Team")
      expect(renamed.lane.legacyTag).toBe("Yoruba")
    }
    const duplicate = await renameTargetLane(t.db, PROJECT, yoruba!.id, "Spanish")
    expect(duplicate.status).toBe("duplicate")
  })

  it("archives an extra lane and refuses the default lane", async () => {
    await ensureProjectLanes(t.db, PROJECT, {
      settings: { targetLanguage: "Spanish", targetLanes: ["French"] },
    })
    const rows = await listProjectLanes(t.db, PROJECT)
    const french = rows.find((lane) => lane.legacyTag === "French")!
    const blank = rows.find((lane) => lane.legacyTag === "")!
    expect((await setTargetLaneArchived(t.db, PROJECT, blank.id, true)).status).toBe("default_lane")
    const archived = await setTargetLaneArchived(t.db, PROJECT, french.id, true)
    expect(archived.status).toBe("ok")
    if (archived.status === "ok") expect(archived.lane.archivedAt).toBeTruthy()
    await insertTargetLane(t.db, PROJECT, {
      id: "aabbccdd",
      name: "Yoruba Team",
      langCode: "yo",
      legacyTag: "aabbccdd",
    })
    const created = (await listProjectLanes(t.db, PROJECT)).find((lane) => lane.id === "aabbccdd")
    expect(created).toMatchObject({ name: "Yoruba Team", legacyTag: "aabbccdd", langCode: "yo" })
  })
})
