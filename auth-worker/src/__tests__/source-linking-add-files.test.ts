// AQU-1560: POST /:projectId/link-source/files — add more of the upstream's
// files to an existing live link, without detaching and re-linking.
//
// The route records the files as a pending addition
// (`projects.source_link_backfill`, migration 0128) and runs the mirror sync,
// which replays their history and only then moves them into the link's
// selection (sync-worker link-sync.ts — covered by link-sync-add-files.test.ts).
// The sync is a call to the sync-worker, so here it is stubbed: a stub that
// "finishes" does what runBackfill's last step does, one that fails leaves the
// addition pending. These tests pin the server half:
//
//   1. Only a Project Lead, only on a live link, only with access to the
//      upstream — and only files the upstream has and the link does not follow.
//   2. The addition is recorded, folded into anything already pending, and the
//      selection itself is left to the sync.
//   3. `complete` tells the client whether the files are in. A failed sync
//      leaves the link following exactly what it followed, and a retry resumes
//      rather than restarts.
//   4. A re-link or a detach drops whatever was pending.

import { env } from "cloudflare:test"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { parseLinkFileIds } from "../services/source-linking"

const DOWN = "proj-1560-down"
const UP = "proj-1560-up"
const MAT = "file-1560-mat"
const MRK = "file-1560-mrk"
const LUK = "file-1560-luk"
const JHN = "file-1560-jhn"

async function seedProject(projectId: string, name: string, createdBy: number): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)")
    .bind(projectId, name, createdBy)
    .run()
}

async function addMember(projectId: string, userId: number, roleLevel: number): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, 1)",
  )
    .bind(projectId, userId, roleLevel)
    .run()
}

async function seedUpstreamFile(fileId: string, name: string): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, kind, event_id, created_at, updated_at, meta)
     VALUES (?, ?, ?, 'text', ?, 1000, 1000, '{}')`,
  )
    .bind(fileId, UP, name, `e-${fileId}`)
    .run()
}

async function setLink(opts: { mode?: string | null; fileIds?: string[] | null; backfill?: string | null }): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `UPDATE projects
        SET source_project_id = ?, source_link_mode = ?, source_link_consumes = 'source',
            source_link_gate = 'validated', source_link_cursor = 40,
            source_link_file_ids = ?, source_link_backfill = ?
      WHERE id = ?`,
  )
    .bind(
      UP,
      opts.mode === undefined ? "live" : opts.mode,
      opts.fileIds === undefined ? JSON.stringify([MAT, MRK]) : opts.fileIds && JSON.stringify(opts.fileIds),
      opts.backfill ?? null,
      DOWN,
    )
    .run()
}

async function linkState(): Promise<{ fileIds: string[] | null; backfill: unknown }> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT source_link_file_ids, source_link_backfill FROM projects WHERE id = ?",
  )
    .bind(DOWN)
    .first<{ source_link_file_ids: string | null; source_link_backfill: string | null }>()
  return {
    fileIds: parseLinkFileIds(row?.source_link_file_ids ?? null),
    backfill: row?.source_link_backfill ? JSON.parse(row.source_link_backfill) : null,
  }
}

async function addFiles(fileIds: unknown, as = "lead"): Promise<Response> {
  return app.request(
    `/api/v2/projects/${DOWN}/link-source/files`,
    { method: "POST", headers: authHeader(await jwtFor(as)), body: JSON.stringify({ fileIds }) },
    env,
  )
}

/** The sync-worker call, finishing the replay the way runBackfill's last step
 *  does: pending files join the selection, the column clears. */
function syncThatFinishes() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const state = await linkState()
    const pending = (state.backfill as { fileIds: string[] } | null)?.fileIds ?? []
    const followed = [...(state.fileIds ?? []), ...pending]
    const all = [MAT, MRK, LUK, JHN].every((id) => followed.includes(id))
    await env.AQUILLA_PG.prepare(
      "UPDATE projects SET source_link_file_ids = ?, source_link_backfill = NULL WHERE id = ?",
    )
      .bind(all ? null : JSON.stringify(followed), DOWN)
      .run()
    return new Response(JSON.stringify({ ranSync: true }), { status: 200 })
  })
}

function syncThatFails() {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("link sync failed", { status: 502 }))
}

beforeEach(async () => {
  vi.restoreAllMocks()
  await seedUser(1, "lead")
  await seedUser(2, "contributor")
  await seedUser(3, "upstream-owner")
  await seedProject(DOWN, "Team C", 1)
  // Owned by someone else, so the lead's access to it is the viewer grant
  // below and nothing more.
  await seedProject(UP, "Gospels", 3)
  await addMember(DOWN, 1, 500)
  await addMember(UP, 1, 100)
  await addMember(DOWN, 2, 300)
  await addMember(UP, 2, 100)
  await seedUpstreamFile(MAT, "MAT.usfm")
  await seedUpstreamFile(MRK, "MRK.usfm")
  await seedUpstreamFile(LUK, "LUK.usfm")
  await seedUpstreamFile(JHN, "JHN.usfm")
  await setLink({})
})

describe("POST /:projectId/link-source/files — adding files to a link (AQU-1560)", () => {
  // WHY: the slice's happy path. The route records LUK as pending and runs the
  // sync; once the sync has brought it in, the answer says so and the link
  // follows it.
  it("records the files, runs the sync, and reports them in", async () => {
    const sync = syncThatFinishes()

    const res = await addFiles([LUK])

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ projectId: DOWN, added: [LUK], fileIds: [MAT, MRK, LUK], complete: true })
    expect(sync).toHaveBeenCalledTimes(1)
    expect(String(sync.mock.calls[0]![0])).toContain(`/api/v1/projects/${DOWN}/link/sync`)
    expect(await linkState()).toEqual({ fileIds: [MAT, MRK, LUK], backfill: null })
  })

  // WHY: AQU-1559's rule, as the client sees it — linking the last unlinked
  // files makes it a whole-project link, which the answer reports as null.
  it("reports a whole-project link once every upstream file is linked", async () => {
    syncThatFinishes()

    const res = await addFiles([LUK, JHN])

    expect(await res.json()).toMatchObject({ added: [LUK, JHN], fileIds: null, complete: true })
  })

  // WHY: "if adding fails, the project's link and existing files are unchanged,
  // the failure is stated, and trying again works". The selection is not
  // touched until the files are in, the answer says they are not, and a retry
  // keeps the replay's progress rather than starting it over.
  it("leaves the link as it was when the sync fails, and resumes on retry", async () => {
    syncThatFails()

    const failed = await addFiles([LUK])

    expect(failed.status).toBe(200)
    expect(await failed.json()).toMatchObject({ added: [LUK], fileIds: [MAT, MRK], complete: false })
    expect(await linkState()).toEqual({ fileIds: [MAT, MRK], backfill: { fileIds: [LUK], doneSeq: 0 } })

    // The failed sync got part-way through the replay before it stopped.
    await env.AQUILLA_PG.prepare("UPDATE projects SET source_link_backfill = ? WHERE id = ?")
      .bind(JSON.stringify({ fileIds: [LUK], doneSeq: 17 }), DOWN)
      .run()
    vi.restoreAllMocks()
    const seenBySync: unknown[] = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      seenBySync.push((await linkState()).backfill)
      await env.AQUILLA_PG.prepare(
        "UPDATE projects SET source_link_file_ids = ?, source_link_backfill = NULL WHERE id = ?",
      )
        .bind(JSON.stringify([MAT, MRK, LUK]), DOWN)
        .run()
      return new Response("{}", { status: 200 })
    })

    const retried = await addFiles([LUK])

    expect(await retried.json()).toMatchObject({ added: [LUK], complete: true })
    expect(seenBySync).toEqual([{ fileIds: [LUK], doneSeq: 17 }])
  })

  // WHY: a second file added while the first is still pending joins the same
  // replay, which restarts so the new file's history is read from the start.
  it("folds a new file into an addition already pending", async () => {
    await setLink({ backfill: JSON.stringify({ fileIds: [LUK], doneSeq: 17 }) })
    syncThatFails()

    await addFiles([JHN])

    expect((await linkState()).backfill).toEqual({ fileIds: [LUK, JHN], doneSeq: 0 })
  })

  // WHY: the mirror sync writes the same column — its replay progress, and the
  // clear when a replay finishes — and may be running while a lead adds
  // another file. The route's write compares against what it read, so a sync
  // that finished LUK in between is not undone by LUK being written back as
  // pending (and replayed all over again).
  it("does not resurrect a pending file that the sync finished meanwhile", async () => {
    await setLink({ backfill: JSON.stringify({ fileIds: [LUK], doneSeq: 17 }) })
    syncThatFails()
    let raced = false
    const racingDb = new Proxy(env.AQUILLA_PG, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver)
        return (sql: string) => {
          const stmt = target.prepare(sql)
          if (raced || !sql.includes("SET source_link_backfill = ?")) return stmt
          return {
            bind: (...values: unknown[]) => ({
              run: async () => {
                raced = true
                // The sync finishing LUK, just before the route's write lands.
                await env.AQUILLA_PG.prepare(
                  "UPDATE projects SET source_link_file_ids = ?, source_link_backfill = NULL WHERE id = ?",
                )
                  .bind(JSON.stringify([MAT, MRK, LUK]), DOWN)
                  .run()
                return stmt.bind(...values).run()
              },
            }),
          }
        }
      },
    })

    await app.request(
      `/api/v2/projects/${DOWN}/link-source/files`,
      { method: "POST", headers: authHeader(await jwtFor("lead")), body: JSON.stringify({ fileIds: [JHN] }) },
      { ...env, AQUILLA_PG: racingDb },
    )

    expect(raced).toBe(true)
    expect(await linkState()).toEqual({ fileIds: [MAT, MRK, LUK], backfill: { fileIds: [JHN], doneSeq: 0 } })
  })

  // WHY: only files the upstream has and the link does not already follow are
  // added. An id that is neither — read a moment ago and gone since, or a
  // locked row sent anyway — is dropped, not refused.
  it("adds only upstream files the link does not already follow", async () => {
    const sync = syncThatFinishes()

    const res = await addFiles([MAT, "file-not-upstream", LUK])

    expect(await res.json()).toMatchObject({ added: [LUK], complete: true })
    expect(sync).toHaveBeenCalledTimes(1)
  })

  // WHY: "confirming with nothing new checked changes nothing" — no write, no
  // sync.
  it("changes nothing when no file is new", async () => {
    const sync = syncThatFinishes()

    const res = await addFiles([MAT, MRK])

    expect(await res.json()).toEqual({ projectId: DOWN, added: [], fileIds: [MAT, MRK], complete: true })
    expect(sync).not.toHaveBeenCalled()
    expect(await linkState()).toEqual({ fileIds: [MAT, MRK], backfill: null })
  })

  // WHY: a whole-project link already follows every file the upstream has or
  // will have; there is nothing to add and nothing to write.
  it("changes nothing on a whole-project link", async () => {
    await setLink({ fileIds: null })
    const sync = syncThatFinishes()

    const res = await addFiles([LUK])

    expect(await res.json()).toEqual({ projectId: DOWN, added: [], fileIds: null, complete: true })
    expect(sync).not.toHaveBeenCalled()
  })

  // WHY: the same floor as linking and detaching. A Contributor does not get a
  // working action — the server refuses it whatever the client shows.
  it("refuses a Contributor", async () => {
    const sync = syncThatFinishes()

    const res = await addFiles([LUK], "contributor")

    expect(res.status).toBe(403)
    expect(sync).not.toHaveBeenCalled()
    expect(await linkState()).toEqual({ fileIds: [MAT, MRK], backfill: null })
  })

  // WHY: adding files copies more of the upstream into this project, so the
  // caller must still be able to see the upstream — the check the link itself
  // makes, applied at the time of the add.
  it("refuses a lead who can no longer see the upstream", async () => {
    await env.AQUILLA_PG.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = 1")
      .bind(UP)
      .run()

    const res = await addFiles([LUK])

    expect(res.status).toBe(403)
    expect(await linkState()).toEqual({ fileIds: [MAT, MRK], backfill: null })
  })

  // WHY: a one-time clone never syncs, so nothing could bring a file in; a
  // legacy link with no recorded mode is not mirrored either.
  it("refuses a clone and a legacy link", async () => {
    for (const mode of ["clone", null]) {
      await setLink({ mode })
      const res = await addFiles([LUK])
      expect(res.status).toBe(409)
      expect((await linkState()).backfill).toBeNull()
    }
  })

  it("refuses a project with no link", async () => {
    await env.AQUILLA_PG.prepare("UPDATE projects SET source_project_id = NULL WHERE id = ?").bind(DOWN).run()

    expect((await addFiles([LUK])).status).toBe(409)
  })

  it("refuses an empty list", async () => {
    expect((await addFiles([])).status).toBe(400)
  })

  // WHY: this worker is deployed independently of migration 0128. Without the
  // column the addition cannot be recorded, which is said, rather than touching
  // the selection directly and bringing the file in from the cursor — half a
  // file, the thing this slice exists to prevent.
  describe("on a database that predates the pending-addition column", () => {
    beforeEach(async () => {
      await env.AQUILLA_PG.prepare("ALTER TABLE projects DROP COLUMN IF EXISTS source_link_backfill").run()
    })
    // The schema outlives the test; every later test needs the column back.
    afterEach(async () => {
      await env.AQUILLA_PG.prepare("ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_link_backfill TEXT").run()
    })

    it("refuses to add, and leaves the selection alone", async () => {
      const sync = syncThatFails()

      const res = await addFiles([LUK])

      expect(res.status).toBe(503)
      expect(sync).not.toHaveBeenCalled()
      const row = await env.AQUILLA_PG.prepare("SELECT source_link_file_ids FROM projects WHERE id = ?")
        .bind(DOWN)
        .first<{ source_link_file_ids: string | null }>()
      expect(parseLinkFileIds(row?.source_link_file_ids)).toEqual([MAT, MRK])
    })
  })
})

describe("re-link and detach drop a pending addition (AQU-1560)", () => {
  beforeEach(async () => {
    await setLink({ backfill: JSON.stringify({ fileIds: [LUK], doneSeq: 3 }) })
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ranSync: true }), { status: 200 }))
  })

  // WHY: a re-link is a fresh answer to "which files". Files part-way into the
  // old link must not ride into the new one.
  it("clears it on re-link", async () => {
    const res = await app.request(
      `/api/v2/projects/${DOWN}/link-source`,
      {
        method: "POST",
        headers: authHeader(await jwtFor("lead")),
        body: JSON.stringify({ sourceProjectId: UP, mode: "live", consumes: "source", fileIds: [MAT] }),
      },
      env,
    )

    expect(res.status).toBe(200)
    expect((await linkState()).backfill).toBeNull()
  })

  it("clears it on detach", async () => {
    const res = await app.request(
      `/api/v2/projects/${DOWN}/detach-source`,
      { method: "POST", headers: authHeader(await jwtFor("lead")) },
      env,
    )

    expect(res.status).toBe(200)
    expect((await linkState()).backfill).toBeNull()
  })
})
