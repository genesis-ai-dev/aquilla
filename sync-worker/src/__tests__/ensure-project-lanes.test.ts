// AQU-1240 slice 6: ensureProjectLanes creates the source + default-target
// rows a new project needs, fills in a language that arrives later, and never
// overwrites a human rename.
//
// AQU-1592: these writers store ONLY what the user typed — the `language`, and
// a `name` / `lang_code` the user set explicitly. A display name and a language
// code are DERIVED on read (laneDisplayName / laneLanguageCode), so the rows
// below carry NULL where a derived value used to be stored. That is the point:
// a code captured at write time keeps claiming the old language after the label
// is edited, which is AQU-1585.

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
  laneDisplayNameSql,
  updateTargetLane,
} from "../../../db/shared/lanes"
import { loadTargetLaneIdentities } from "../../../db/shared/lane-visibility"
import { loadTargetLanes } from "../events/lane-read-wall"
import { planLaneGrants } from "../../../src/lib/lanes/grant-backfill"
import { lanesForRequestedTag } from "../../../src/lib/lanes/read-wall"
import {
  BLANK_LANE_PLACEHOLDER,
  SOURCE_LANE_PLACEHOLDER,
} from "../../../src/lib/lanes/backfill-plan"
import { laneDisplayName, laneLanguageCode } from "../../../src/lib/lanes/lane-display"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const PROJECT = "proj-ensure-lanes"

async function lanes(t: TestDb) {
  const r = await t.pg.query<{
    role: string
    language: string | null
    name: string | null
    lang_code: string | null
    legacy_tag: string | null
  }>(
    `SELECT role, language, name, lang_code, legacy_tag FROM lanes
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
    // AQU-1592: the placeholders are NOT stored — the row carries an empty
    // language and no name, and laneDisplayName derives the placeholder on read.
    expect(await lanes(t)).toEqual([
      {
        role: "source",
        language: "",
        name: null,
        lang_code: null,
        legacy_tag: null,
      },
      {
        role: "target",
        language: "",
        name: null,
        lang_code: null,
        legacy_tag: "",
      },
    ])
    const rows = await listProjectLanes(t.db, PROJECT)
    expect(laneDisplayName(rows.find((l) => l.role === "source")!)).toBe(SOURCE_LANE_PLACEHOLDER)
    expect(laneDisplayName(rows.find((l) => l.role === "target")!)).toBe(BLANK_LANE_PLACEHOLDER)
  })

  it("stores the language from settings and derives the code on read", async () => {
    await ensureProjectLanes(t.db, PROJECT, {
      settings: { sourceLanguage: "English", targetLanguage: "Spanish", targetLanes: ["French"] },
    })
    // Only the typed language is stored. No derived name, no derived code.
    expect(await lanes(t)).toEqual([
      { role: "source", language: "English", name: null, lang_code: null, legacy_tag: null },
      { role: "target", language: "Spanish", name: null, lang_code: null, legacy_tag: "" },
      { role: "target", language: "French", name: null, lang_code: null, legacy_tag: "French" },
    ])
    // The catalog codes come back through the read helper instead.
    const records = await listProjectLanes(t.db, PROJECT)
    expect(records.map((lane) => [laneDisplayName(lane), laneLanguageCode(lane)])).toEqual([
      ["English", "en"],
      ["Spanish", "es"],
      ["French", "fr"],
    ])
  })

  it("moves the derived code with the language instead of letting it drift (AQU-1585)", async () => {
    await ensureProjectLanes(t.db, PROJECT, { settings: { targetLanguage: "Spanish" } })
    const before = (await listProjectLanes(t.db, PROJECT)).find((l) => l.legacyTag === "")!
    expect(laneLanguageCode(before)).toBe("es")
    const edited = await updateTargetLane(t.db, PROJECT, before.id, { language: "French" })
    expect(edited.status).toBe("ok")
    const after = (await listProjectLanes(t.db, PROJECT)).find((l) => l.legacyTag === "")!
    // Nothing derived was stored, so the code follows the new language.
    expect(laneDisplayName(after)).toBe("French")
    expect(laneLanguageCode(after)).toBe("fr")
    expect(after.langCode).toBeNull()
  })

  it("keeps a code override across a language edit", async () => {
    await ensureProjectLanes(t.db, PROJECT, { settings: { targetLanguage: "Spanish" } })
    const lane = (await listProjectLanes(t.db, PROJECT)).find((l) => l.legacyTag === "")!
    expect((await updateTargetLane(t.db, PROJECT, lane.id, { code: "es-mx" })).status).toBe("ok")
    expect((await updateTargetLane(t.db, PROJECT, lane.id, { language: "Mexican Spanish" })).status)
      .toBe("ok")
    const after = (await listProjectLanes(t.db, PROJECT)).find((l) => l.legacyTag === "")!
    expect(after.language).toBe("Mexican Spanish")
    // Canonicalized on the way in, and untouched by the language edit.
    expect(after.langCode).toBe("es-MX")
    expect(laneLanguageCode(after)).toBe("es-MX")
  })

  it("refuses a malformed code override rather than storing it", async () => {
    await ensureProjectLanes(t.db, PROJECT, { settings: { targetLanguage: "Spanish" } })
    const lane = (await listProjectLanes(t.db, PROJECT)).find((l) => l.legacyTag === "")!
    expect((await updateTargetLane(t.db, PROJECT, lane.id, { code: "not a tag!" })).status).toBe(
      "malformed_code",
    )
    const after = (await listProjectLanes(t.db, PROJECT)).find((l) => l.legacyTag === "")!
    expect(after.langCode).toBeNull()
  })

  it("clears a name override so the lane falls back to showing its language", async () => {
    await ensureProjectLanes(t.db, PROJECT, { settings: { targetLanguage: "Spanish" } })
    const lane = (await listProjectLanes(t.db, PROJECT)).find((l) => l.legacyTag === "")!
    await updateTargetLane(t.db, PROJECT, lane.id, { name: "Draft Spanish" })
    expect(laneDisplayName((await listProjectLanes(t.db, PROJECT))[1]!)).toBe("Draft Spanish")
    await updateTargetLane(t.db, PROJECT, lane.id, { name: null })
    const after = (await listProjectLanes(t.db, PROJECT)).find((l) => l.legacyTag === "")!
    expect(after.name).toBeNull()
    expect(laneDisplayName(after)).toBe("Spanish")
  })

  it("refuses an edit that would leave the lane with nothing to display", async () => {
    await ensureProjectLanes(t.db, PROJECT, { settings: { targetLanguage: "Spanish" } })
    const lane = (await listProjectLanes(t.db, PROJECT)).find((l) => l.legacyTag === "")!
    expect((await updateTargetLane(t.db, PROJECT, lane.id, { language: "  " })).status).toBe("empty")
  })

  it("refuses a display-name collision with a lane that only carries a language", async () => {
    await ensureProjectLanes(t.db, PROJECT, {
      settings: { targetLanguage: "Spanish", targetLanes: ["Yoruba"] },
    })
    const yoruba = (await listProjectLanes(t.db, PROJECT)).find((l) => l.legacyTag === "Yoruba")!
    // "Spanish" is the default lane's LANGUAGE, not its stored name, and it is
    // still what that lane shows — so naming this one "Spanish" collides.
    expect((await updateTargetLane(t.db, PROJECT, yoruba.id, { name: "Spanish" })).status).toBe(
      "duplicate",
    )
  })

  it("fills in languages that arrive later, without changing ids", async () => {
    await ensureProjectLanes(t.db, PROJECT, { settings: {} })
    const before = await t.pg.query<{ id: string; role: string }>(
      `SELECT id, role FROM lanes WHERE project_id = $1 ORDER BY role`,
      [PROJECT],
    )
    await ensureProjectLanes(t.db, PROJECT, {
      settings: { sourceLanguage: "English", targetLanguage: "Spanish" },
    })
    const after = await t.pg.query<{ id: string; role: string; language: string | null }>(
      `SELECT id, role, language FROM lanes WHERE project_id = $1 ORDER BY role`,
      [PROJECT],
    )
    expect(after.rows.map((r) => r.id)).toEqual(before.rows.map((r) => r.id))
    expect(after.rows.find((r) => r.role === "source")?.language).toBe("English")
    expect(after.rows.find((r) => r.role === "target")?.language).toBe("Spanish")
  })

  it("retires a stored placeholder name so the derived display takes over", async () => {
    // A row written before migration 0129 stores the placeholder as its name.
    await t.pg.query(
      `INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position)
       VALUES ('aabbccdd', $1, 'target', NULL, $2, NULL, '', 0)`,
      [PROJECT, BLANK_LANE_PLACEHOLDER],
    )
    await ensureProjectLanes(t.db, PROJECT, { settings: { targetLanguage: "Spanish" } })
    const row = (await listProjectLanes(t.db, PROJECT)).find((l) => l.legacyTag === "")!
    expect(row.name).toBeNull()
    expect(laneDisplayName(row)).toBe("Spanish")
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
    // And the language the user already set is not overwritten either.
    expect(rows.find((r) => r.role === "target")?.language).toBe("Spanish")
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
      `INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position)
       VALUES ($1, $2, 'source', '', NULL, NULL, NULL, 0)`,
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
    // AQU-1592: the placeholders are derived, so nothing stores them.
    expect((await lanes(t)).map((r) => r.name)).toEqual([null, null])
    expect((await listProjectLanes(t.db, PROJECT)).map(laneDisplayName).sort()).toEqual(
      [BLANK_LANE_PLACEHOLDER, SOURCE_LANE_PLACEHOLDER].sort(),
    )
  })

  it("stores lane languages from settingsSeed", async () => {
    await createProjectShared(t.db, {
      projectId: PROJECT,
      name: "P",
      orgId: null,
      createdBy: 1,
      settingsSeed: { sourceLanguage: "English", targetLanguage: "Spanish" },
    })
    const rows = await lanes(t)
    expect(rows.find((r) => r.role === "source")).toMatchObject({
      language: "English",
      name: null,
      lang_code: null,
    })
    expect(rows.find((r) => r.role === "target")).toMatchObject({
      language: "Spanish",
      name: null,
      lang_code: null,
      legacy_tag: "",
    })
    const records = await listProjectLanes(t.db, PROJECT)
    expect(records.map(laneLanguageCode)).toEqual(["en", "es"])
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
    expect(rows.find((r) => r.role === "source")?.language).toBe("English")
    expect(rows.find((r) => r.role === "target" && r.legacy_tag === "")?.language).toBe("Spanish")
    expect(rows.find((r) => r.legacy_tag === "French")?.language).toBe("French")
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
      // AQU-1592: a rename touches the name override only — the language the
      // lane was created for is still what it translates into.
      expect(renamed.lane.language).toBe("Yoruba")
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
      language: "Yoruba",
      name: "Yoruba Team",
      langCode: "yo-NG",
      legacyTag: "aabbccdd",
    })
    const created = (await listProjectLanes(t.db, PROJECT)).find((lane) => lane.id === "aabbccdd")
    expect(created).toMatchObject({
      language: "Yoruba",
      name: "Yoruba Team",
      legacyTag: "aabbccdd",
      langCode: "yo-NG",
    })
  })
})

describe("readers that select lane rows directly see the display name", () => {
  it("a lane that stores only its language is matched, labelled, and granted by that language", async () => {
    await ensureProjectLanes(t.db, PROJECT, { settings: { targetLanguage: "Spanish" } })
    await insertTargetLane(t.db, PROJECT, {
      id: "aabbccdd",
      language: "Yoruba",
      name: null,
      langCode: null,
      legacyTag: "aabbccdd",
    })

    for (const identities of [await loadTargetLanes(t.db, PROJECT), await loadTargetLaneIdentities(t.db, PROJECT)]) {
      expect(identities.find((lane) => lane.id === "aabbccdd")?.name).toBe("Yoruba")
      expect(lanesForRequestedTag(identities, "Yoruba").map((lane) => lane.id)).toEqual(["aabbccdd"])
      const plan = planLaneGrants({ roleLevel: 300, laneScopes: ["Yoruba"], lanes: identities })
      expect(plan.grants.map((grant) => grant.laneId)).toEqual(["aabbccdd"])
    }
  })

  it("falls back to the role placeholder, and stays NULL when no lane row joined", async () => {
    await ensureProjectLanes(t.db, PROJECT, { settings: {} })
    const placeholders = await t.pg.query<{ role: string; label: string }>(
      `SELECT role, ${laneDisplayNameSql("lanes")} AS label FROM lanes WHERE project_id = $1 ORDER BY role`,
      [PROJECT],
    )
    expect(placeholders.rows).toEqual([
      { role: "source", label: SOURCE_LANE_PLACEHOLDER },
      { role: "target", label: BLANK_LANE_PLACEHOLDER },
    ])
    const missing = await t.pg.query<{ label: string | null }>(
      `SELECT ${laneDisplayNameSql("ln")} AS label
         FROM (SELECT 1) AS one LEFT JOIN lanes ln ON ln.id = 'no-such-lane'`,
    )
    expect(missing.rows).toEqual([{ label: null }])
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
      { role: "source", language: "English", name: null, lang_code: null, legacy_tag: null },
      { role: "target", language: "Spanish", name: null, lang_code: null, legacy_tag: "" },
      { role: "target", language: "French", name: null, lang_code: null, legacy_tag: "French" },
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
      language: "Yoruba",
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
      language: "Yoruba",
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

  it("recognises a default lane that stores only its language", () => {
    const languageOnly = { role: "target", language: "Spanish", name: null, legacyTag: "" }
    expect(isDefaultLaneUnderAnotherName("Spanish", [source, languageOnly])).toBe(true)
    const blank = { role: "target", language: null, name: null, legacyTag: "" }
    expect(isDefaultLaneUnderAnotherName("Spanish", [source, blank])).toBe(false)
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
