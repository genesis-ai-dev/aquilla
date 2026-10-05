// AQU-1240 slice 6: ensureProjectLanes creates the source + default-target
// rows a new project needs, promotes placeholder names when languages arrive,
// and never overwrites a human rename.

import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { createProjectShared, updateProjectSettingsShared } from "../../../db/shared/projects"
import {
  ensureProjectLanes,
  ensureProjectLaneStmts,
  insertTargetLane,
  isDefaultLaneUnderAnotherName,
  listProjectLanes,
  renameTargetLane,
  setTargetLaneArchived,
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

  // AQU-1600: the former default lane is ordinary. It archives like any other
  // lane; the only refusal left is the project's LAST active target lane.
  it("archives the former default lane like any other, and refuses the last active one", async () => {
    await ensureProjectLanes(t.db, PROJECT, {
      settings: { targetLanguage: "Spanish", targetLanes: ["French"] },
    })
    const rows = await listProjectLanes(t.db, PROJECT)
    const french = rows.find((lane) => lane.legacyTag === "French")!
    const blank = rows.find((lane) => lane.legacyTag === "")!
    // The former default lane archives, and keeps its legacy tag so old
    // events still replay through it.
    const blankArchived = await setTargetLaneArchived(t.db, PROJECT, blank.id, true)
    expect(blankArchived.status).toBe("ok")
    if (blankArchived.status === "ok") {
      expect(blankArchived.lane.archivedAt).toBeTruthy()
      expect(blankArchived.lane.legacyTag).toBe("")
    }
    // French is now the only active target lane, so archiving it is refused.
    expect((await setTargetLaneArchived(t.db, PROJECT, french.id, true)).status).toBe("last_lane")
    // Restore the former default lane and French archives again.
    expect((await setTargetLaneArchived(t.db, PROJECT, blank.id, false)).status).toBe("ok")
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

// AQU-1585: changing the project target language on Project Info used to leave
// the old language behind as an empty duplicate lane, and re-coded the default
// lane without renaming it ("Spanish" with lang_code 'pt').
describe("AQU-1585 editing the project target language", () => {
  /** Create the project, then the create dialog's one atomic settings write. */
  async function createEnglishSpanishPlusFrench() {
    await createProjectShared(t.db, {
      projectId: PROJECT,
      name: "P",
      orgId: null,
      createdBy: 1,
    })
    const result = await updateProjectSettingsShared(t.db, {
      projectId: PROJECT,
      settings: {
        sourceLanguage: "English",
        targetLanguage: "Spanish",
        // completeTargetLanes() includes the primary in the registry.
        targetLanes: ["Spanish", "French"],
      },
      ifMatchVersion: 0,
      updatedBy: 1,
    })
    expect(result.status).toBe("ok")
  }

  it("creates the extra lanes the create dialog asked for", async () => {
    await createEnglishSpanishPlusFrench()
    expect(await lanes(t)).toEqual([
      { role: "source", name: "English", lang_code: "en", legacy_tag: null },
      { role: "target", name: "Spanish", lang_code: "es", legacy_tag: "" },
      { role: "target", name: "French", lang_code: "fr", legacy_tag: "French" },
    ])
  })

  it("does not spawn a lane for the language the default lane already is", async () => {
    await createEnglishSpanishPlusFrench()
    const before = (await lanes(t)).map((r) => r.legacy_tag)

    // Project Info: target language Spanish -> Portuguese. The registry still
    // lists "Spanish" (the UI does not rewrite it), so that entry is now stale.
    const changed = await updateProjectSettingsShared(t.db, {
      projectId: PROJECT,
      settings: {
        sourceLanguage: "English",
        targetLanguage: "Portuguese",
        targetLanes: ["Spanish", "French"],
      },
      ifMatchVersion: 1,
      updatedBy: 1,
    })
    expect(changed.status).toBe("ok")

    // The project still has exactly the lanes it had: no empty second "Spanish".
    // (What the default lane is *called* and *coded* is AQU-1592's derive-on-read
    // work, not this fix — it only guarantees the lane set is untouched.)
    expect((await lanes(t)).map((r) => r.legacy_tag)).toEqual(before)
    expect((await lanes(t)).filter((r) => r.role === "target")).toHaveLength(2)
  })

  it("still registers a brand-new lane declared only in the settings registry", async () => {
    // The external Agent API has no insertTargetLane path — PatchSettings on
    // targetLanes is how it declares a lane ("register it in settings.targetLanes").
    await createEnglishSpanishPlusFrench()
    const added = await updateProjectSettingsShared(t.db, {
      projectId: PROJECT,
      settings: {
        sourceLanguage: "English",
        targetLanguage: "Spanish",
        targetLanes: ["Spanish", "French", "fr-CA", "Yoruba"],
      },
      ifMatchVersion: 1,
      updatedBy: 1,
    })
    expect(added.status).toBe("ok")
    const tags = (await lanes(t))
      .filter((r) => r.role === "target")
      .map((r) => r.legacy_tag)
      .sort()
    // The stale "Spanish" entry is still refused; the new ones land, including a
    // regional lane beside its base primary (AQU-1532).
    expect(tags).toEqual(["", "French", "Yoruba", "fr-CA"].sort())
  })

  it("still keeps a lane added through the lanes route, which inserts the row before syncing the registry", async () => {
    await createEnglishSpanishPlusFrench()
    // What POST /:projectId/lanes does: insert the row, then merge the tag into
    // settings.targetLanes — so the settings write only has to promote it.
    await insertTargetLane(t.db, PROJECT, {
      id: "11223344",
      name: "Yoruba Team",
      langCode: "yo",
      legacyTag: "Yoruba",
    })
    const synced = await updateProjectSettingsShared(t.db, {
      projectId: PROJECT,
      settings: {
        sourceLanguage: "English",
        targetLanguage: "Spanish",
        targetLanes: ["Spanish", "French", "Yoruba"],
      },
      ifMatchVersion: 1,
      updatedBy: 1,
    })
    expect(synced.status).toBe("ok")
    const rows = await lanes(t)
    expect(rows.filter((r) => r.role === "target")).toHaveLength(3)
    expect(rows.find((r) => r.legacy_tag === "Yoruba")).toEqual({
      role: "target",
      name: "Yoruba Team",
      lang_code: "yo",
      legacy_tag: "Yoruba",
    })
  })
})

describe("isDefaultLaneUnderAnotherName", () => {
  const source = { role: "source", name: "English", legacyTag: null }
  const spanish = { role: "target", name: "Spanish", legacyTag: "" }
  const unnamed = { role: "target", name: BLANK_LANE_PLACEHOLDER, legacyTag: "" }

  it("recognises the default lane's own language, whatever targetLanguage now says", () => {
    expect(isDefaultLaneUnderAnotherName("Spanish", [source, spanish])).toBe(true)
    expect(isDefaultLaneUnderAnotherName("spanish", [source, spanish])).toBe(true)
  })

  it("leaves a genuinely different lane alone", () => {
    expect(isDefaultLaneUnderAnotherName("French", [source, spanish])).toBe(false)
    // AQU-1532: a regional lane beside its base primary is its own lane.
    expect(
      isDefaultLaneUnderAnotherName("fr-CA", [
        source,
        { role: "target", name: "French", legacyTag: "" },
      ]),
    ).toBe(false)
  })

  it("says nothing when there is no named default lane, or for the lanes it never drops", () => {
    expect(isDefaultLaneUnderAnotherName("Spanish", [])).toBe(false)
    expect(isDefaultLaneUnderAnotherName("Spanish", [source, unnamed])).toBe(false)
    expect(isDefaultLaneUnderAnotherName("", [source, spanish])).toBe(false)
    expect(isDefaultLaneUnderAnotherName(null, [source, spanish])).toBe(false)
  })
})
