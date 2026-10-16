// AQU-1559: a link may follow only SOME of the upstream's files.
//
// The route used to take "which upstream" and nothing else, so a link always
// meant the whole project — every file it had and every one it gained later. The
// confirm step now lets a Project Lead uncheck files, and the picked UPSTREAM
// file ids ride on the link request. These tests pin the server half of that:
//
//   1. `fileIds` is stored as the link's followed-file list, and an omitted
//      `fileIds` stores NULL — the whole-project link every existing row has.
//   2. Re-linking without a selection CLEARS a previous one, rather than
//      inheriting a list the user did not ask for.
//   3. An empty `fileIds` is refused: a link that follows no files could never
//      sync anything, so it is a mistake rather than a link.
//   4. Detach copies only the followed files. This is the one place a subset
//      link could still hand the project files it never followed — detach keeps
//      what the link brought in, it does not widen it.
//   5. GET /:projectId surfaces the selection and the upstream's file count, so
//      the Source link card can say "N of M files" after a reload.

import { env } from "cloudflare:test"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { parseLinkFileIds } from "../services/source-linking"

const DOWN = "proj-1559-down"
const UP = "proj-1559-up"
const MAT = "file-1559-mat"
const MRK = "file-1559-mrk"
const LUK = "file-1559-luk"

async function seedProjectWithLead(projectId: string, name: string): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, 1)")
    .bind(projectId, name)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, 1, 500, 1)",
  )
    .bind(projectId)
    .run()
}

/** An upstream file with one source cell, so a detach has something to copy. */
async function seedUpstreamFile(fileId: string, name: string, value: string): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, kind, event_id, created_at, updated_at, meta)
     VALUES (?, ?, ?, 'text', ?, 1000, 1000, '{}')`,
  )
    .bind(fileId, UP, name, `e-${fileId}`)
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at)
     VALUES (?, ?, ?, 'source', ?, ?, 2000)`,
  )
    .bind(UP, fileId, `${fileId}-c1`, value, `e-${fileId}-c1`)
    .run()
}

async function linkRequest(body: Record<string, unknown>): Promise<Response> {
  return app.request(
    `/api/v2/projects/${DOWN}/link-source`,
    {
      method: "POST",
      headers: authHeader(await jwtFor("lead")),
      body: JSON.stringify(body),
    },
    env,
  )
}

async function storedSelection(): Promise<string[] | null> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT source_link_file_ids FROM projects WHERE id = ?",
  )
    .bind(DOWN)
    .first<{ source_link_file_ids: string | null }>()
  return parseLinkFileIds(row?.source_link_file_ids ?? null)
}

async function downstreamFileNames(): Promise<string[]> {
  const rows = await env.AQUILLA_PG.prepare(
    "SELECT name FROM files WHERE project_id = ? AND deleted_at IS NULL ORDER BY name",
  )
    .bind(DOWN)
    .all<{ name: string }>()
  return (rows.results ?? []).map((r) => r.name)
}

beforeEach(async () => {
  await seedUser(1, "lead")
  await seedProjectWithLead(DOWN, "Downstream team")
  await seedProjectWithLead(UP, "Upstream Bible")
  await seedUpstreamFile(MAT, "MAT.usfm", "The book of the generation")
  await seedUpstreamFile(MRK, "MRK.usfm", "The beginning of the gospel")
  await seedUpstreamFile(LUK, "LUK.usfm", "Forasmuch as many have taken in hand")
  // The seed sync is a call to the sync-worker; these tests are about what the
  // route stores, so it is stubbed (it is best-effort either way).
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ranSync: true }), { status: 200 }),
  )
})

describe("POST /:projectId/link-source — followed-file selection (AQU-1559)", () => {
  // WHY: the picked ids ARE the link's scope — everything downstream of here
  // (the mirror fold, the detach snapshot, the card's "N of M") reads this one
  // column, so it has to hold exactly what the lead checked.
  it("stores the picked upstream file ids and echoes them back", async () => {
    const res = await linkRequest({
      sourceProjectId: UP,
      mode: "live",
      consumes: "source",
      fileIds: [MAT, MRK],
    })

    expect(res.status).toBe(200)
    expect(((await res.json()) as { fileIds: string[] }).fileIds).toEqual([MAT, MRK])
    expect(await storedSelection()).toEqual([MAT, MRK])
  })

  // WHY: the regression guard for every client and every link that predates this
  // slice. No selection must store NULL, which every reader treats as "follow the
  // whole project" — storing the upstream's current files instead would silently
  // pin the link and stop its later files arriving.
  it("stores no selection when the request omits one", async () => {
    const res = await linkRequest({ sourceProjectId: UP, mode: "live", consumes: "source" })

    expect(res.status).toBe(200)
    expect(((await res.json()) as { fileIds: string[] | null }).fileIds).toBeNull()
    expect(await storedSelection()).toBeNull()
  })

  // WHY: a re-link is a fresh answer to "how much of this upstream?" — the same
  // way it resets the cursor. Inheriting the old list would leave a link the lead
  // confirmed with everything checked quietly following two files.
  it("clears a previous selection when the project is re-linked without one", async () => {
    await linkRequest({ sourceProjectId: UP, mode: "live", consumes: "source", fileIds: [MAT] })
    expect(await storedSelection()).toEqual([MAT])

    await linkRequest({ sourceProjectId: UP, mode: "live", consumes: "source" })

    expect(await storedSelection()).toBeNull()
  })

  // WHY: "follow no files" is not a link — it could never sync anything. The
  // client disables its own confirm button on an empty selection; a request that
  // got past that must be refused rather than saved.
  it("refuses an empty selection", async () => {
    const res = await linkRequest({
      sourceProjectId: UP,
      mode: "live",
      consumes: "source",
      fileIds: [],
    })

    expect(res.status).toBe(400)
    const row = await env.AQUILLA_PG.prepare("SELECT source_project_id FROM projects WHERE id = ?")
      .bind(DOWN)
      .first<{ source_project_id: string | null }>()
    expect(row?.source_project_id).toBeNull()
  })

  // WHY: detach is the place a subset link could still widen itself — it copies
  // "the upstream's source" into the project. It must copy only the files the
  // link actually followed, or the unpicked ones the lead refused would arrive at
  // the moment they stopped following the upstream at all.
  it("copies only the followed files on detach", async () => {
    await linkRequest({
      sourceProjectId: UP,
      mode: "live",
      consumes: "source",
      fileIds: [MAT, MRK],
    })

    const res = await app.request(
      `/api/v2/projects/${DOWN}/detach-source`,
      { method: "POST", headers: authHeader(await jwtFor("lead")) },
      env,
    )

    expect(res.status).toBe(200)
    expect(await downstreamFileNames()).toEqual(["MAT.usfm", "MRK.usfm"])
    // And the link is gone, selection included — a future re-link starts clean.
    expect(await storedSelection()).toBeNull()
  })

  // WHY: the whole-project half of the same action. A link with no selection
  // detaches to the whole upstream, exactly as it always has.
  it("copies every upstream file on detach from a whole-project link", async () => {
    await linkRequest({ sourceProjectId: UP, mode: "live", consumes: "source" })

    await app.request(
      `/api/v2/projects/${DOWN}/detach-source`,
      { method: "POST", headers: authHeader(await jwtFor("lead")) },
      env,
    )

    expect(await downstreamFileNames()).toEqual(["LUK.usfm", "MAT.usfm", "MRK.usfm"])
  })
})

// AQU-1559 — a database that predates migration 0127. A per-PR preview deploys
// this worker against the shared development database with no migration applied,
// and production applies migrations separately from the deploy, so the window is
// real in both. The new capability may be unavailable there; nothing that worked
// before this slice may break.
describe("source links on a database without source_link_file_ids (AQU-1559)", () => {
  // The suite's database is reset between tests by DATA, not by schema, so the
  // column is dropped per test and put back afterwards — otherwise the first case
  // here would leave every later test running against a half-migrated table.
  async function dropTheColumn(): Promise<void> {
    await env.AQUILLA_PG.prepare(
      "ALTER TABLE projects DROP COLUMN IF EXISTS source_link_file_ids",
    ).run()
  }

  afterEach(async () => {
    await env.AQUILLA_PG.prepare(
      "ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_link_file_ids TEXT",
    ).run()
  })

  // WHY: the regression a QA walk caught. `GET /api/v2/projects/:id` is the read
  // behind every project open, so selecting the new column alongside the project
  // row made an un-migrated database 500 the whole app — not merely withhold a
  // badge. The field reads as "no selection", which is exactly what a
  // whole-project link means.
  it("still serves the project read, withholding the selection", async () => {
    await linkRequest({ sourceProjectId: UP, mode: "live", consumes: "source" })
    await dropTheColumn()

    const res = await app.request(
      `/api/v2/projects/${DOWN}`,
      { headers: authHeader(await jwtFor("lead")) },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      sourceProjectId: string | null
      sourceLinkFileIds: string[] | null
      sourceLinkUpstreamFileCount: number | null
    }
    expect(body.sourceProjectId).toBe(UP)
    expect(body.sourceLinkFileIds).toBeNull()
    expect(body.sourceLinkUpstreamFileCount).toBeNull()
  })

  // WHY: linking a whole project never needed the column, so it must not start
  // failing because of it — the route falls back to the pre-slice statement.
  it("still links a whole project", async () => {
    await dropTheColumn()

    const res = await linkRequest({ sourceProjectId: UP, mode: "live", consumes: "source" })

    expect(res.status).toBe(200)
    const row = await env.AQUILLA_PG.prepare(
      "SELECT source_project_id, source_link_mode FROM projects WHERE id = ?",
    )
      .bind(DOWN)
      .first<{ source_project_id: string; source_link_mode: string }>()
    expect(row?.source_project_id).toBe(UP)
    expect(row?.source_link_mode).toBe("live")
  })

  // WHY: a subset link genuinely cannot be stored there, and quietly saving a
  // whole-project link instead would hand the project every file the lead just
  // declined. Refusing is the honest answer, and it leaves the project unlinked.
  it("refuses a subset link rather than silently linking everything", async () => {
    await dropTheColumn()

    const res = await linkRequest({
      sourceProjectId: UP,
      mode: "live",
      consumes: "source",
      fileIds: [MAT, MRK],
    })

    expect(res.status).toBe(500)
    const row = await env.AQUILLA_PG.prepare("SELECT source_project_id FROM projects WHERE id = ?")
      .bind(DOWN)
      .first<{ source_project_id: string | null }>()
    expect(row?.source_project_id).toBeNull()
  })

  // WHY: detach is how a team gets out of a link, so it is the last thing that
  // may break on an un-migrated database. With no selection to read it copies the
  // whole upstream — the pre-slice behaviour.
  it("still detaches, copying the whole upstream", async () => {
    await linkRequest({ sourceProjectId: UP, mode: "live", consumes: "source" })
    await dropTheColumn()

    const res = await app.request(
      `/api/v2/projects/${DOWN}/detach-source`,
      { method: "POST", headers: authHeader(await jwtFor("lead")) },
      env,
    )

    expect(res.status).toBe(200)
    expect(await downstreamFileNames()).toEqual(["LUK.usfm", "MAT.usfm", "MRK.usfm"])
  })
})

describe("GET /:projectId — followed-file selection (AQU-1559)", () => {
  // WHY: after a reload the confirm step is long gone, so this response is the
  // only way the Source link card can say how much of the upstream the link
  // follows. The upstream's total comes from the server because the downstream
  // client cannot count a project's files without reading that project.
  it("returns the selection and the upstream's file count for a subset link", async () => {
    await linkRequest({
      sourceProjectId: UP,
      mode: "live",
      consumes: "source",
      fileIds: [MAT, MRK],
    })

    const res = await app.request(
      `/api/v2/projects/${DOWN}`,
      { headers: authHeader(await jwtFor("lead")) },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      sourceLinkFileIds: string[] | null
      sourceLinkUpstreamFileCount: number | null
    }
    expect(body.sourceLinkFileIds).toEqual([MAT, MRK])
    expect(body.sourceLinkUpstreamFileCount).toBe(3)
  })

  // AQU-1566: the upstream's hidden timeline files (a dubbing cue sheet, a
  // caption track's content) are not files anyone can pick, so they are not in M.
  it("leaves the upstream's hidden timeline files out of its file count", async () => {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO files (id, project_id, name, kind, role, anchor_file_id, event_id, created_at, updated_at, meta)
       VALUES ('up-cues', ?, 'MAT audio', 'vtt', 'audio-cues', ?, 'e-up-cues', 1000, 1000, '{}'),
              ('up-track', ?, 'MAT captions', 'vtt', 'timeline-content', ?, 'e-up-track', 1000, 1000, '{}')`,
    )
      .bind(UP, MAT, UP, MAT)
      .run()
    await linkRequest({ sourceProjectId: UP, mode: "live", consumes: "source", fileIds: [MAT, MRK] })

    const res = await app.request(`/api/v2/projects/${DOWN}`, { headers: authHeader(await jwtFor("lead")) }, env)
    const body = (await res.json()) as { sourceLinkUpstreamFileCount: number | null }
    expect(body.sourceLinkUpstreamFileCount).toBe(3)
  })

  // WHY: a whole-project link is stated without a count ("All files"), so it must
  // come back as null rather than as a list of everything — which would read as a
  // pinned link.
  it("returns no selection for a whole-project link", async () => {
    await linkRequest({ sourceProjectId: UP, mode: "live", consumes: "source" })

    const res = await app.request(
      `/api/v2/projects/${DOWN}`,
      { headers: authHeader(await jwtFor("lead")) },
      env,
    )

    const body = (await res.json()) as {
      sourceLinkFileIds: string[] | null
      sourceLinkUpstreamFileCount: number | null
    }
    expect(body.sourceLinkFileIds).toBeNull()
    expect(body.sourceLinkUpstreamFileCount).toBeNull()
  })
})
