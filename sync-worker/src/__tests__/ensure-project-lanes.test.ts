// AQU-1240 slice 6: ensureProjectLanes creates the source + default-target
// rows a new project needs, promotes placeholder names when languages arrive,
// and never overwrites a human rename.

import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { createProjectShared, updateProjectSettingsShared } from "../../../db/shared/projects"
import {
  ensureProjectLanes,
  ensureProjectLaneStmts,
} from "../../../db/shared/lanes"
import {
  BLANK_LANE_PLACEHOLDER,
  SOURCE_LANE_PLACEHOLDER,
} from "../../../src/lib/lanes/backfill-plan"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

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

  it("assigns 8-hex ids that are per-project unique and stable on re-run", async () => {
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
    await t.pg.query(
      `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
       VALUES ($1, $2, 'source', 'Source', NULL, NULL, 0)`,
      [sharedId, otherProject],
    )
    const both = await t.pg.query<{ project_id: string; id: string }>(
      `SELECT project_id, id FROM lanes WHERE id = $1 ORDER BY project_id`,
      [sharedId],
    )
    expect(both.rows).toEqual([
      { project_id: PROJECT, id: sharedId },
      { project_id: otherProject, id: sharedId },
    ])

    await ensureProjectLanes(t.db, PROJECT, { settings: { targetLanguage: "Spanish" } })
    const again = await t.pg.query<{ id: string }>(
      `SELECT id FROM lanes WHERE project_id = $1 ORDER BY role, legacy_tag NULLS FIRST`,
      [PROJECT],
    )
    expect(again.rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id))
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
