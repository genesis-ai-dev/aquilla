// AQU-2348: archiving a language lane KEEPS its Living Memory, and restoring
// the lane brings it back.
//
// Why this needs a test of its own rather than a reading of the code:
// archiving is the one lifecycle event that could plausibly be expected to
// clean up after itself, and if it ever did, a team that archived a lane for a
// season would silently lose the register, audience notes and style rules they
// authored for it — work that is expensive to reconstruct and whose loss would
// only show up a release later. The guarantee is that `setTargetLaneArchived`
// moves `lanes.archived_at` and NOTHING else: the lane's settings keys are
// keyed by `lanes.id`, which archiving does not touch, and its rows keep their
// `lane_id`. The writers deliberately refuse an ARCHIVED lane (a closed lane
// accepts no new memory), so "restoring brings it back" is the behaviour that
// has to hold — not "you can keep writing to it".

import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { readBriefForLane } from "../../../db/shared/brief"
import { createDoc, listProjectDocsForLane } from "../../../db/shared/knowledge"
import { resolveLaneMemory } from "../../../db/shared/lane-memory"
import { insertTargetLane, setTargetLaneArchived } from "../../../db/shared/lanes"
import { createRule, listRulesForProject } from "../../../db/shared/style-rules"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const PROJECT = "proj-lane-memory-archive"
const ES = "0f0f0f0f"
const FR = "a1b2c3d4"

const LANE_BRIEF = {
  version: 3,
  updatedAt: "2026-11-03T00:00:00.000Z",
  updatedBy: "maintainer",
  parameters: { registerNaturalness: "Formal liturgical register" },
  l1Summary: "Spanish lane: formal liturgical register.",
}

let t: TestDb
beforeEach(async () => {
  if (!t) t = await makeTestDb()
  else await t.reset()
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Archive memory', 1)`, [
    PROJECT,
  ])
  await t.pg.query(
    `INSERT INTO lanes (id, project_id, role, language, legacy_tag, position)
       VALUES ('5ce00000', $1, 'source', 'Greek', NULL, 0)`,
    [PROJECT],
  )
  await insertTargetLane(t.db, PROJECT, { id: ES, language: "Spanish", legacyTag: "es" })
  await insertTargetLane(t.db, PROJECT, { id: FR, language: "French", legacyTag: "fr" })
})
afterAll(async () => {
  await t?.close()
})

/** Everything the Spanish lane owns: both prose sections and both row kinds. */
async function seedSpanishLaneMemory(): Promise<void> {
  await t.pg.query(
    `INSERT INTO project_settings (project_id, settings) VALUES ($1, $2)`,
    [
      PROJECT,
      JSON.stringify({
        systemPrompt: "Project instructions.",
        systemPromptByLane: { [ES]: "Spanish lane instructions." },
        translationBriefByLane: { [ES]: LANE_BRIEF },
      }),
    ],
  )
  await createRule(t.db, {
    owner: { projectId: PROJECT },
    laneId: ES,
    instruction: "Use the formal register.",
    category: "register",
    scope: "global",
  })
  await createDoc(t.db, {
    id: "dddddddd-0000-0000-0000-000000000001",
    scope: { projectId: PROJECT },
    name: "es-style.md",
    contentType: "text/markdown",
    sizeBytes: 12,
    sha256: "abc",
    r2Key: "kb/project/es-style",
    extractedText: "Formal register notes.",
    createdBy: "maintainer",
    laneId: ES,
  })
}

async function settingsBlob(): Promise<Record<string, unknown>> {
  const row = await t.pg.query<{ settings: unknown }>(
    `SELECT settings FROM project_settings WHERE project_id = $1`,
    [PROJECT],
  )
  const raw = row.rows[0]?.settings
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>
}

/** The lane's own memory, as every prompt reader resolves it. */
async function spanishLaneMemory() {
  const settings = await settingsBlob()
  const resolved = resolveLaneMemory(settings, ES)
  return {
    systemPrompt: resolved.systemPrompt,
    brief: readBriefForLane(settings, ES),
    rules: (await listRulesForProject(t.db, PROJECT, undefined, { laneId: ES })).rules.map(
      (r) => r.instruction,
    ),
    docs: (await listProjectDocsForLane(t.db, PROJECT, ES)).map((d) => d.name),
  }
}

describe("archiving a lane and its Living Memory (AQU-2348)", () => {
  it("keeps every section the lane owns while it is archived, and after it is restored", async () => {
    await seedSpanishLaneMemory()
    const before = await spanishLaneMemory()
    expect(before.systemPrompt).toEqual({ value: "Spanish lane instructions.", source: "lane" })
    expect(before.brief.source).toBe("lane")
    expect(before.rules).toEqual(["Use the formal register."])
    expect(before.docs).toEqual(["es-style.md"])

    expect((await setTargetLaneArchived(t.db, PROJECT, ES, true)).status).toBe("ok")
    expect(await spanishLaneMemory()).toEqual(before)

    expect((await setTargetLaneArchived(t.db, PROJECT, ES, false)).status).toBe("ok")
    expect(await spanishLaneMemory()).toEqual(before)
  })

  it("changes nothing for the other lane or for the project", async () => {
    await seedSpanishLaneMemory()
    await setTargetLaneArchived(t.db, PROJECT, ES, true)

    const settings = await settingsBlob()
    // French never owned a copy, so it still inherits the project's — the same
    // answer it gave before the Spanish lane was customized OR archived.
    expect(resolveLaneMemory(settings, FR)).toMatchObject({
      systemPrompt: { value: "Project instructions.", source: "project" },
    })
    expect(readBriefForLane(settings, FR).source).toBe("project")
    expect((await listRulesForProject(t.db, PROJECT, undefined, { laneId: FR })).rules).toEqual([])
    expect(await listProjectDocsForLane(t.db, PROJECT, FR)).toEqual([])
    // And the project-wide instructions are untouched.
    expect(settings.systemPrompt).toBe("Project instructions.")
  })

  it("does not touch the project_settings row at all — the keys are byte-identical", async () => {
    await seedSpanishLaneMemory()
    const before = JSON.stringify(await settingsBlob())
    await setTargetLaneArchived(t.db, PROJECT, ES, true)
    await setTargetLaneArchived(t.db, PROJECT, ES, false)
    expect(JSON.stringify(await settingsBlob())).toBe(before)
  })
})
