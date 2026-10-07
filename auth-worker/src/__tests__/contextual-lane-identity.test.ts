// AQU-1610: the contextual pipeline's lane is `lane_id`, and every run, draft,
// brief and readiness count keys on it rather than on the legacy `target_lang`
// tag those tables also carry.
//
// The tag is not an identity. `lanes.legacy_tag` is NULLABLE and exists only
// as the bridge for events written before lane ids (AQU-1419): a lane created
// after the cutover has none, and a lane retagged later has a different one
// than its rows. Every such lane reads back as `target_lang = ''` — which is
// the FORMER DEFAULT LANE's tag. Keyed on the tag, the three uniqueness rules
// (`contextual_runs_active`, `contextual_drafts_live`, `scene_briefs_live`)
// then hand that lane the default lane's slot: its run is refused as "already
// active", its proposal supersedes the other lane's, and approving its brief
// archives the other lane's brief on the same span.
//
// These tests pin the id as the identity so a reader cannot drift back.
import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import {
  createRun,
  getActiveRun,
  listRuns,
  insertDrafts,
  listDrafts,
  countDrafts,
  terminateRun,
  getProjectAutopilotSummary,
  listAutopilotCandidateFiles,
} from "../../../db/shared/contextual-runs"
import { proposeSceneBrief, reviewSceneBrief, listSceneBriefs } from "../../../db/shared/scene-briefs"

const db = env.AQUILLA_PG
const PROJECT = "proj-lane-id"
const FILE = "file-lane-id"

/** The former default lane: the one every pre-lane-id row points at. */
const LANE_DEFAULT = "lndefault"
/**
 * A lane created after the lane-id cutover. It has NO legacy tag, so it reads
 * back as `target_lang = ''` — the default lane's tag — which is exactly the
 * collision the tag-keyed rules could not see.
 */
const LANE_UNTAGGED = "lnuntagd"

async function seedLanes(): Promise<void> {
  await db
    .prepare("INSERT INTO lanes (id, project_id, role, name, legacy_tag, position) VALUES (?, ?, 'source', 'Source', NULL, 0)")
    .bind("lnsource", PROJECT)
    .run()
  await db
    .prepare("INSERT INTO lanes (id, project_id, role, name, legacy_tag, position) VALUES (?, ?, 'target', 'Spanish', '', 1)")
    .bind(LANE_DEFAULT, PROJECT)
    .run()
  await db
    .prepare("INSERT INTO lanes (id, project_id, role, name, legacy_tag, position) VALUES (?, ?, 'target', 'Quechua', NULL, 2)")
    .bind(LANE_UNTAGGED, PROJECT)
    .run()
}

/** One source cell, plus an optional target row per lane. */
async function seedCell(
  cellId: string,
  opts: { targets?: { laneId: string; value: string; validated?: 0 | 1 }[] } = {},
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, lane_id, value, event_id, last_edit_at)
       VALUES (?, ?, ?, 'source', '', 'lnsource', ?, ?, 0)`,
    )
    .bind(PROJECT, FILE, cellId, `source ${cellId}`, `ev-s-${cellId}`)
    .run()
  for (const t of opts.targets ?? []) {
    await db
      .prepare(
        `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, lane_id, value, validated, event_id, last_edit_at)
         VALUES (?, ?, ?, 'target', '', ?, ?, ?, ?, 0)`,
      )
      .bind(PROJECT, FILE, cellId, t.laneId, t.value, t.validated ?? 0, `ev-t-${cellId}-${t.laneId}`)
      .run()
  }
}

beforeEach(async () => {
  await db.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, 'Lane identity', 1)").bind(PROJECT).run()
  await db.prepare("INSERT INTO files (id, project_id, name, event_id) VALUES (?, ?, 'Mark', 'ev-file')").bind(FILE, PROJECT).run()
  await seedLanes()
})

describe("a run belongs to a lane id, not to a tag", () => {
  it("lets an untagged lane hold its own active run beside the former default lane's", async () => {
    const first = await createRun(db, { projectId: PROJECT, fileId: FILE, laneId: LANE_DEFAULT })
    expect(first.status).toBe("ok")

    // Both lanes spell their tag `''`. Keyed on the tag this was
    // `active_exists`, pointing the second lane at the first lane's run.
    const second = await createRun(db, { projectId: PROJECT, fileId: FILE, laneId: LANE_UNTAGGED })
    expect(second.status).toBe("ok")
    if (first.status !== "ok" || second.status !== "ok") throw new Error("unreachable")
    expect(second.run.id).not.toBe(first.run.id)
    expect(second.run.laneId).toBe(LANE_UNTAGGED)

    // And each lane still refuses a SECOND active run of its own.
    expect((await createRun(db, { projectId: PROJECT, fileId: FILE, laneId: LANE_UNTAGGED })).status)
      .toBe("active_exists")

    // Hydrate and history read the lane they were asked for.
    expect((await getActiveRun(db, PROJECT, FILE, { laneId: LANE_UNTAGGED }))?.id).toBe(second.run.id)
    expect((await getActiveRun(db, PROJECT, FILE, { laneId: LANE_DEFAULT }))?.id).toBe(first.run.id)
    expect((await listRuns(db, PROJECT, { fileId: FILE, laneId: LANE_UNTAGGED })).runs.map((r) => r.id))
      .toEqual([second.run.id])

    // Terminating one frees only its own lane.
    await terminateRun(db, first.run.id)
    expect(await getActiveRun(db, PROJECT, FILE, { laneId: LANE_DEFAULT })).toBeNull()
    expect((await getActiveRun(db, PROJECT, FILE, { laneId: LANE_UNTAGGED }))?.id).toBe(second.run.id)
  })

  it("keeps a live proposal per lane on the same cell", async () => {
    await seedCell("c1")
    const a = await createRun(db, { projectId: PROJECT, fileId: FILE, laneId: LANE_DEFAULT })
    const b = await createRun(db, { projectId: PROJECT, fileId: FILE, laneId: LANE_UNTAGGED })
    if (a.status !== "ok" || b.status !== "ok") throw new Error("unreachable")

    await insertDrafts(db, {
      projectId: PROJECT, fileId: FILE, runId: a.run.id,
      drafts: [{ cellId: "c1", text: "en español" }],
    })
    // Keyed on the tag, this supersede+upsert took over the row above.
    await insertDrafts(db, {
      projectId: PROJECT, fileId: FILE, runId: b.run.id,
      drafts: [{ cellId: "c1", text: "runasimipi" }],
    })

    const spanish = await listDrafts(db, PROJECT, FILE, "proposed", { laneId: LANE_DEFAULT })
    const quechua = await listDrafts(db, PROJECT, FILE, "proposed", { laneId: LANE_UNTAGGED })
    expect(spanish.map((d) => d.text)).toEqual(["en español"])
    expect(quechua.map((d) => d.text)).toEqual(["runasimipi"])
    expect(await countDrafts(db, PROJECT, FILE, { laneId: LANE_DEFAULT })).toMatchObject({ proposed: 1, superseded: 0 })
    expect(await countDrafts(db, PROJECT, FILE, { laneId: LANE_UNTAGGED })).toMatchObject({ proposed: 1, superseded: 0 })
  })

  it("gives each lane its own row in the project rollup", async () => {
    await createRun(db, { projectId: PROJECT, fileId: FILE, laneId: LANE_DEFAULT })
    await createRun(db, { projectId: PROJECT, fileId: FILE, laneId: LANE_UNTAGGED })
    const summary = await getProjectAutopilotSummary(db, PROJECT)
    expect(summary.files.map((f) => f.laneId).sort()).toEqual([LANE_DEFAULT, LANE_UNTAGGED])
    expect(summary.activeRuns).toBe(2)
  })
})

describe("an approved scene brief belongs to a lane id", () => {
  it("does not archive the other lane's brief on the same span", async () => {
    const spanish = await proposeSceneBrief(db, {
      projectId: PROJECT, fileId: FILE, startCellId: "c1", endCellId: "c2",
      laneId: LANE_DEFAULT, construal: "Spanish reading",
    })
    const quechua = await proposeSceneBrief(db, {
      projectId: PROJECT, fileId: FILE, startCellId: "c1", endCellId: "c2",
      laneId: LANE_UNTAGGED, construal: "Quechua reading",
    })
    if (spanish.status !== "ok" || quechua.status !== "ok") throw new Error("unreachable")
    expect(spanish.brief.laneId).toBe(LANE_DEFAULT)
    expect(quechua.brief.laneId).toBe(LANE_UNTAGGED)

    expect((await reviewSceneBrief(db, { id: spanish.brief.id, action: "approve" })).status).toBe("ok")
    // Keyed on the tag, approving this one archived the Spanish brief.
    expect((await reviewSceneBrief(db, { id: quechua.brief.id, action: "approve" })).status).toBe("ok")

    const approvedSpanish = await listSceneBriefs(db, PROJECT, { status: "approved", laneId: LANE_DEFAULT })
    const approvedQuechua = await listSceneBriefs(db, PROJECT, { status: "approved", laneId: LANE_UNTAGGED })
    expect(approvedSpanish.map((b) => b.construal)).toEqual(["Spanish reading"])
    expect(approvedQuechua.map((b) => b.construal)).toEqual(["Quechua reading"])
  })
})

describe("work left is counted in the lane that was asked about", () => {
  it("does not credit an untouched lane with the default lane's translations", async () => {
    // Both cells are fully translated in the default lane and empty in the
    // untagged one. Keyed on the tag, the untagged lane borrowed the default
    // lane's rows and Autopilot reported a wholly untranslated language as
    // having no work left.
    await seedCell("c1", { targets: [{ laneId: LANE_DEFAULT, value: "uno", validated: 1 }] })
    await seedCell("c2", { targets: [{ laneId: LANE_DEFAULT, value: "dos", validated: 1 }] })

    expect(await listAutopilotCandidateFiles(db, PROJECT, { laneId: LANE_DEFAULT })).toEqual([])
    const untagged = await listAutopilotCandidateFiles(db, PROJECT, { laneId: LANE_UNTAGGED })
    expect(untagged.map((f) => [f.fileId, f.untranslatedCells])).toEqual([[FILE, 2]])
  })
})

describe("the drafts read takes a lane id", () => {
  // The SPA and the Worker deploy separately, so the route still accepts the
  // legacy `?targetLang=` tag — but `?laneId=` is the identity and wins, and
  // a lane whose tag is the default lane's is reachable only by id.
  async function seedViewer(): Promise<string> {
    await seedUser(3, "viewer")
    await env.AQUILLA_PG
      .prepare("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, 3, 100, 3)")
      .bind(PROJECT)
      .run()
    return jwtFor("viewer")
  }

  async function drafts(jwt: string, query: string): Promise<{ laneId: string; text: string }[]> {
    const res = await app.request(
      `/api/v2/projects/${PROJECT}/contextual/drafts?fileId=${FILE}&status=proposed&${query}`,
      { method: "GET", headers: authHeader(jwt) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { drafts: { laneId: string; text: string }[] }
    return body.drafts
  }

  it("prefers ?laneId= over a tag, and reaches an untagged lane the tag cannot name", async () => {
    const jwt = await seedViewer()
    await seedCell("c1")
    const a = await createRun(db, { projectId: PROJECT, fileId: FILE, laneId: LANE_DEFAULT })
    const b = await createRun(db, { projectId: PROJECT, fileId: FILE, laneId: LANE_UNTAGGED })
    if (a.status !== "ok" || b.status !== "ok") throw new Error("unreachable")
    await insertDrafts(db, {
      projectId: PROJECT, fileId: FILE, runId: a.run.id, drafts: [{ cellId: "c1", text: "en español" }],
    })
    await insertDrafts(db, {
      projectId: PROJECT, fileId: FILE, runId: b.run.id, drafts: [{ cellId: "c1", text: "runasimipi" }],
    })

    // Legacy tag: the former default lane, as before.
    expect((await drafts(jwt, "targetLang=")).map((d) => d.text)).toEqual(["en español"])
    // By id: each lane, including the one whose tag is also ''.
    expect((await drafts(jwt, `laneId=${LANE_DEFAULT}`)).map((d) => d.text)).toEqual(["en español"])
    expect((await drafts(jwt, `laneId=${LANE_UNTAGGED}`)).map((d) => d.text)).toEqual(["runasimipi"])
    // The id wins over a tag naming the other lane.
    expect((await drafts(jwt, `laneId=${LANE_UNTAGGED}&targetLang=`)).map((d) => d.text)).toEqual(["runasimipi"])
  })
})

/**
 * AQU-1610: the Workers deploy separately from migration 0151, in either
 * order, so for one window the running code meets the OTHER world's indexes.
 * A QA walk on the preview (shared development database, un-migrated) caught
 * exactly that: every staged draft failed with *"there is no unique or
 * exclusion constraint matching the ON CONFLICT specification"* and the run
 * reported zero proposals.
 *
 * These rebuild the three live-row indexes in their PRE-0151 shape and then
 * run the same writers, so the fallback cannot rot.
 */
describe("the writers survive a database migration 0151 has not reached", () => {
  beforeEach(async () => {
    await db.prepare("DROP INDEX IF EXISTS contextual_drafts_live").run()
    await db
      .prepare(
        `CREATE UNIQUE INDEX contextual_drafts_live
           ON contextual_drafts(project_id, file_id, cell_id, target_lang)
         WHERE status = 'proposed'`,
      )
      .run()
    await db.prepare("DROP INDEX IF EXISTS scene_briefs_live").run()
    await db
      .prepare(
        `CREATE UNIQUE INDEX scene_briefs_live
           ON scene_briefs(project_id, file_id, start_cell_id, end_cell_id, target_lang)
         WHERE status = 'approved'`,
      )
      .run()
    await db.prepare("DROP INDEX IF EXISTS contextual_runs_active").run()
    await db
      .prepare(
        `CREATE UNIQUE INDEX contextual_runs_active
           ON contextual_runs(project_id, file_id, target_lang)
         WHERE status IN ('running','pausing','paused','parked','waiting')`,
      )
      .run()
  })

  it("stages drafts rather than failing the ON CONFLICT specification", async () => {
    await seedCell("c1")
    const run = await createRun(db, { projectId: PROJECT, fileId: FILE, laneId: LANE_DEFAULT })
    if (run.status !== "ok") throw new Error("unreachable")

    const staged = await insertDrafts(db, {
      projectId: PROJECT, fileId: FILE, runId: run.run.id,
      drafts: [{ cellId: "c1", text: "en español" }],
    })
    expect(staged.map((d) => d.text)).toEqual(["en español"])
    expect(await countDrafts(db, PROJECT, FILE, { laneId: LANE_DEFAULT })).toMatchObject({ proposed: 1 })

    // A re-propose still supersedes rather than colliding.
    const again = await insertDrafts(db, {
      projectId: PROJECT, fileId: FILE, runId: run.run.id,
      drafts: [{ cellId: "c1", text: "otra vez" }],
    })
    expect(again.map((d) => d.text)).toEqual(["otra vez"])
  })

  it("approves a sibling lane's scene brief rather than colliding with the holder it cannot see", async () => {
    const spanish = await proposeSceneBrief(db, {
      projectId: PROJECT, fileId: FILE, startCellId: "c1", endCellId: "c2",
      laneId: LANE_DEFAULT, construal: "Spanish reading",
    })
    const quechua = await proposeSceneBrief(db, {
      projectId: PROJECT, fileId: FILE, startCellId: "c1", endCellId: "c2",
      laneId: LANE_UNTAGGED, construal: "Quechua reading",
    })
    if (spanish.status !== "ok" || quechua.status !== "ok") throw new Error("unreachable")
    expect((await reviewSceneBrief(db, { id: spanish.brief.id, action: "approve" })).status).toBe("ok")

    // Both lanes spell their tag '', so on this database the span key cannot
    // tell them apart. Archiving by lane_id would leave the Spanish brief in
    // the slot and the approve would hit the unique index; archiving by the
    // key actually in force supersedes it, which is the pre-0151 behaviour
    // this window has to keep — a refusal here is a run that cannot finish.
    expect((await reviewSceneBrief(db, { id: quechua.brief.id, action: "approve" })).status).toBe("ok")
    const approved = await listSceneBriefs(db, PROJECT, { status: "approved" })
    expect(approved.map((b) => b.construal)).toEqual(["Quechua reading"])
  })

  it("reports the former default lane's run as active_exists, not a database error", async () => {
    const first = await createRun(db, { projectId: PROJECT, fileId: FILE, laneId: LANE_DEFAULT })
    if (first.status !== "ok") throw new Error("unreachable")
    // Both lanes spell their tag '', and the pre-0151 index is keyed on it, so
    // the second lane's run is refused by the database. The caller still gets
    // the domain answer rather than a raw constraint error — the honest one
    // for this database, which cannot hold both runs until 0151 lands.
    const second = await createRun(db, { projectId: PROJECT, fileId: FILE, laneId: LANE_UNTAGGED })
    expect(second).toEqual({ status: "active_exists", runId: first.run.id })
  })
})
