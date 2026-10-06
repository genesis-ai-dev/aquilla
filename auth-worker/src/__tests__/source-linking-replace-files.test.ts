// AQU-1679: a link may follow INTO a file the project already has.
//
// Linking an established project was additive only: an upstream file sharing a
// name with one of the project's own arrived as a second copy, and the team's
// translations stayed on the unlinked one. The confirm step now offers, per
// such file, "replace the source in my existing file"; the pairs ride on the
// link request as `replaceFiles`. These tests pin the server half:
//
//   1. POST /link-source/match answers how the two files compare — the numbers
//      the confirm step shows — with the same pairing the mirror then performs.
//   2. `replaceFiles` is stored as the link's adopted files, all pending, in
//      the same write as the link; a link without it clears a previous record.
//   3. A request the mirror could not honour is refused before anything is
//      saved: the wrong kind of link, a pair outside the selection, a file
//      paired twice, or two files that are not the same material.
//   4. Detach writes the upstream's text onto the project's own cells in a
//      followed-into file, and creates no second copy of it.
//   5. A database that predates migration 0140 still links.

import { env } from "cloudflare:test"
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { parseSourceLinkAdoption } from "../../../db/shared/source-link-adopt"

const DOWN = "proj-1679-down"
const UP = "proj-1679-up"
const UP_MRK = "file-1679-up-mrk"
const UP_MAT = "file-1679-up-mat"
const OWN_MRK = "file-1679-own-mrk"

const MARK = ["The beginning of the gospel", "As it is written in the prophets", "The voice of one crying"]

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

/** A file whose source lines are chained in order, as an importer writes them. */
async function seedFile(
  projectId: string,
  fileId: string,
  name: string,
  cellPrefix: string,
  lines: readonly string[],
): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, kind, event_id, created_at, updated_at, meta)
     VALUES (?, ?, ?, 'text', ?, 1000, 1000, '{}')`,
  )
    .bind(fileId, projectId, name, `e-${fileId}`)
    .run()
  for (let i = 0; i < lines.length; i++) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, anchor_cell_id, event_id, last_edit_at)
       VALUES (?, ?, ?, 'source', ?, ?, ?, 2000)`,
    )
      .bind(
        projectId,
        fileId,
        `${cellPrefix}-${i + 1}`,
        lines[i],
        i === 0 ? null : `${cellPrefix}-${i}`,
        `e-${fileId}-${String(i + 1).padStart(3, "0")}`,
      )
      .run()
  }
}

async function post(path: string, body: Record<string, unknown>, username = "lead"): Promise<Response> {
  return app.request(
    `/api/v2/projects/${DOWN}${path}`,
    { method: "POST", headers: authHeader(await jwtFor(username)), body: JSON.stringify(body) },
    env,
  )
}

const linkRequest = (body: Record<string, unknown>) => post("/link-source", body)
const liveSourceLink = (extra: Record<string, unknown> = {}) =>
  linkRequest({ sourceProjectId: UP, mode: "live", consumes: "source", ...extra })

async function storedAdoption() {
  const row = await env.AQUILLA_PG.prepare("SELECT source_link_adopt FROM projects WHERE id = ?")
    .bind(DOWN)
    .first<{ source_link_adopt: string | null }>()
  return parseSourceLinkAdoption(row?.source_link_adopt ?? null)
}

async function linkedTo(): Promise<string | null> {
  const row = await env.AQUILLA_PG.prepare("SELECT source_project_id FROM projects WHERE id = ?")
    .bind(DOWN)
    .first<{ source_project_id: string | null }>()
  return row?.source_project_id ?? null
}

beforeEach(async () => {
  await seedUser(1, "lead")
  await seedProjectWithLead(DOWN, "Downstream team")
  await seedProjectWithLead(UP, "Upstream Bible")
  await seedFile(UP, UP_MRK, "MRK.usfm", "up", MARK)
  await seedFile(UP, UP_MAT, "MAT.usfm", "mat", ["The book of the generation"])
  await seedFile(DOWN, OWN_MRK, "MRK.usfm", "own", MARK)
  // The seed sync is a call to the sync-worker; these tests are about what the
  // routes decide and store, so it is stubbed (it is best-effort either way).
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ ranSync: true }), { status: 200 }),
  )
})

describe("POST /:projectId/link-source/match (AQU-1679)", () => {
  // WHY: these are the numbers a lead reads before choosing to replace, so they
  // have to be the pairing the mirror actually makes.
  it("reports a file imported from the same material as a full match", async () => {
    const res = await post("/link-source/match", {
      sourceProjectId: UP,
      files: [{ upstreamFileId: UP_MRK, fileId: OWN_MRK }],
    })

    expect(res.status).toBe(200)
    expect(((await res.json()) as { files: unknown[] }).files).toEqual([
      {
        upstreamFileId: UP_MRK,
        fileId: OWN_MRK,
        missing: false,
        upstreamLines: 3,
        localLines: 3,
        same: 3,
        changed: 0,
        added: 0,
        kept: 0,
        canReplace: true,
      },
    ])
  })

  // WHY: sharing a name is not sharing content. Two unrelated files must come
  // back as not replaceable, or the option would overwrite a source the team's
  // translations were made from with something else.
  it("reports unrelated files, and a file that is not there, as not replaceable", async () => {
    const res = await post("/link-source/match", {
      sourceProjectId: UP,
      files: [
        { upstreamFileId: UP_MAT, fileId: OWN_MRK },
        { upstreamFileId: UP_MRK, fileId: "file-that-does-not-exist" },
      ],
    })

    const { files } = (await res.json()) as {
      files: Array<{ canReplace: boolean; missing: boolean; same: number }>
    }
    expect(files.map((f) => [f.canReplace, f.missing, f.same])).toEqual([
      [false, false, 0],
      [false, true, 0],
    ])
  })

  // WHY: the comparison reads the upstream's source text, so it needs the same
  // access to the upstream the link itself does.
  it("refuses a caller with no access to the upstream", async () => {
    await env.AQUILLA_PG.prepare("DELETE FROM project_members WHERE project_id = ?").bind(UP).run()
    await env.AQUILLA_PG.prepare("UPDATE projects SET created_by = 999 WHERE id = ?").bind(UP).run()

    const res = await post("/link-source/match", {
      sourceProjectId: UP,
      files: [{ upstreamFileId: UP_MRK, fileId: OWN_MRK }],
    })

    expect(res.status).toBe(403)
  })
})

describe("POST /:projectId/link-source — replaceFiles (AQU-1679)", () => {
  // WHY: this record is what makes the mirror write into the project's own file.
  // It has to name the pair and mark it pending, or the first sync would mirror
  // the upstream file in as a copy before anything joined the two.
  it("stores the pairs as the link's adopted files, all pending, and echoes them back", async () => {
    const res = await liveSourceLink({ replaceFiles: [{ upstreamFileId: UP_MRK, fileId: OWN_MRK }] })

    expect(res.status).toBe(200)
    expect(((await res.json()) as { replaceFiles: unknown }).replaceFiles).toEqual([
      { upstreamFileId: UP_MRK, fileId: OWN_MRK },
    ])
    expect(await storedAdoption()).toEqual({ files: { [UP_MRK]: OWN_MRK }, pending: [UP_MRK] })
  })

  // WHY: a re-link is a fresh answer to every question the link flow asks.
  // Inheriting the old pairs would keep a file joined that the lead just chose
  // to have as a separate copy.
  it("clears a previous record when the project is re-linked without one", async () => {
    await liveSourceLink({ replaceFiles: [{ upstreamFileId: UP_MRK, fileId: OWN_MRK }] })
    expect(await storedAdoption()).not.toBeNull()

    const res = await liveSourceLink()

    expect(res.status).toBe(200)
    expect(((await res.json()) as { replaceFiles: unknown }).replaceFiles).toBeNull()
    expect(await storedAdoption()).toBeNull()
  })

  // WHY: each of these is a request the mirror could not honour as asked. They
  // are refused outright, and the project is left unlinked, rather than saved
  // as something the lead did not choose.
  it.each([
    ["a one-time copy", { mode: "clone" }],
    ["a chain link", { consumes: "target" }],
    ["a file outside the link's selection", { fileIds: [UP_MAT] }],
  ])("refuses to replace a file's source on %s", async (_label, extra) => {
    const res = await liveSourceLink({
      ...extra,
      replaceFiles: [{ upstreamFileId: UP_MRK, fileId: OWN_MRK }],
    })

    expect(res.status).toBe(400)
    expect(await linkedTo()).toBeNull()
  })

  it("refuses one file paired with two upstream files", async () => {
    const res = await liveSourceLink({
      replaceFiles: [
        { upstreamFileId: UP_MRK, fileId: OWN_MRK },
        { upstreamFileId: UP_MAT, fileId: OWN_MRK },
      ],
    })

    expect(res.status).toBe(400)
    expect(await linkedTo()).toBeNull()
  })

  // WHY: the confirm step already disables this, from the match route. A request
  // that got past it — or raced an edit — must still not be saved, and must say
  // which file did not match.
  it("refuses, with the comparison, when the files are not the same material", async () => {
    const res = await liveSourceLink({ replaceFiles: [{ upstreamFileId: UP_MAT, fileId: OWN_MRK }] })

    expect(res.status).toBe(422)
    const body = (await res.json()) as { replaceFiles: Array<{ fileId: string; canReplace: boolean }> }
    expect(body.replaceFiles).toMatchObject([{ fileId: OWN_MRK, canReplace: false }])
    expect(await linkedTo()).toBeNull()
    expect(await storedAdoption()).toBeNull()
  })
})

describe("POST /:projectId/detach-source — a followed-into file (AQU-1679)", () => {
  // WHY: detach makes the project self-contained by writing the upstream's
  // current text into it. For a file the link followed into, that text belongs
  // on the project's OWN cells — where the translations are. Matched by the
  // upstream's ids it would instead add every line a second time, in the same
  // file, or the whole file a second time.
  it("writes the upstream's text onto the project's own cells and adds no copy", async () => {
    await liveSourceLink({ replaceFiles: [{ upstreamFileId: UP_MRK, fileId: OWN_MRK }] })
    // What the mirror's join leaves behind (sync-worker events/link-adopt.ts).
    await env.AQUILLA_PG.prepare(
      `UPDATE projects SET source_link_adopt = ? WHERE id = ?`,
    )
      .bind(JSON.stringify({ files: { [UP_MRK]: OWN_MRK }, pending: [] }), DOWN)
      .run()
    await env.AQUILLA_PG.prepare(
      `UPDATE cells SET upstream_cell_id = 'up-' || split_part(cell_id, '-', 2)
        WHERE project_id = ? AND file_id = ?`,
    )
      .bind(DOWN, OWN_MRK)
      .run()
    // The upstream moved on after the last sync.
    await env.AQUILLA_PG.prepare(
      `UPDATE cells SET value = 'As it is written in Isaiah' WHERE project_id = ? AND cell_id = 'up-2'`,
    )
      .bind(UP)
      .run()

    const res = await app.request(
      `/api/v2/projects/${DOWN}/detach-source`,
      { method: "POST", headers: authHeader(await jwtFor("lead")) },
      env,
    )
    expect(res.status).toBe(200)

    const files = await env.AQUILLA_PG.prepare(
      "SELECT id, name FROM files WHERE project_id = ? AND deleted_at IS NULL ORDER BY name",
    )
      .bind(DOWN)
      .all<{ id: string; name: string }>()
    // One MRK — the project's own — beside the copy of the upstream's other file.
    expect((files.results ?? []).map((f) => f.name)).toEqual(["MAT.usfm", "MRK.usfm"])
    expect((files.results ?? []).find((f) => f.name === "MRK.usfm")?.id).toBe(OWN_MRK)

    const cells = await env.AQUILLA_PG.prepare(
      `SELECT cell_id, value FROM cells
        WHERE project_id = ? AND file_id = ? AND side = 'source' ORDER BY cell_id`,
    )
      .bind(DOWN, OWN_MRK)
      .all<{ cell_id: string; value: string }>()
    expect((cells.results ?? []).map((c) => [c.cell_id, c.value])).toEqual([
      ["own-1", MARK[0]],
      ["own-2", "As it is written in Isaiah"],
      ["own-3", MARK[2]],
    ])
    expect(await storedAdoption()).toBeNull()
  })
})

// A per-PR preview deploys this worker against the shared development database
// with no migration applied, and production applies migrations separately from
// the deploy. Replacing a file may be unavailable there; linking may not break.
describe("source links on a database without source_link_adopt (AQU-1679)", () => {
  afterEach(async () => {
    await env.AQUILLA_PG.prepare(
      "ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_link_adopt TEXT",
    ).run()
  })

  it("still links and detaches when nothing is replaced, and refuses a replace it cannot record", async () => {
    await env.AQUILLA_PG.prepare("ALTER TABLE projects DROP COLUMN IF EXISTS source_link_adopt").run()

    const replace = await liveSourceLink({ replaceFiles: [{ upstreamFileId: UP_MRK, fileId: OWN_MRK }] })
    expect(replace.status).toBe(500)
    expect(await linkedTo()).toBeNull()

    const plain = await liveSourceLink()
    expect(plain.status).toBe(200)
    expect(await linkedTo()).toBe(UP)

    const detach = await app.request(
      `/api/v2/projects/${DOWN}/detach-source`,
      { method: "POST", headers: authHeader(await jwtFor("lead")) },
      env,
    )
    expect(detach.status).toBe(200)
  })
})
