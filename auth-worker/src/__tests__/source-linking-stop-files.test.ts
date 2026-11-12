// AQU-1562: POST /:projectId/link-source/files/stop and
// GET /:projectId/link-source/files — stop this project following ONE of the
// upstream's files, keeping it as the project's own copy.
//
// Until this slice the choice only grew. A team that linked a file by mistake,
// or that wanted to take one book in its own direction while the rest kept
// following the upstream, had to delete the file (losing its translations) or
// run "Detach from source", which cuts every file loose at once and cannot be
// undone.
//
// The whole operation is a narrowing of the link's selection, because the
// selection is what the mirror filters its fold by (sync-worker link-sync.ts,
// `fileFilter` — the sync half is covered by link-sync-stop-files.test.ts).
// So these tests pin the server half:
//
//   1. The selection narrows, and NOTHING ELSE moves: the file, its cells and
//      everything on them stay exactly where they were.
//   2. A whole-project link materializes into the fixed list of the rest
//      (AQU-1559's rule), which the answer reports so the client can say the
//      upstream's later files will no longer arrive on their own.
//   3. At least one file must stay linked — stopping everything is detach.
//   4. Only a Project Lead, only on a live link; losing access to the upstream
//      does NOT take the ability to stop reading it away.
//   5. GET tells a stopped file (here, with its translations) from one this
//      project never had, which is the difference between the two confirms.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { parseLinkFileIds, deterministicDownstreamFileId } from "../services/source-linking"

const DOWN = "proj-1562-down"
const UP = "proj-1562-up"
const MAT = "file-1562-mat"
const MRK = "file-1562-mrk"
const LUK = "file-1562-luk"

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

async function seedFile(projectId: string, fileId: string, name: string): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, kind, event_id, created_at, updated_at, meta)
     VALUES (?, ?, ?, 'text', ?, 1000, 1000, '{}')`,
  )
    .bind(fileId, projectId, name, `e-${fileId}`)
    .run()
}

/** The downstream's mirrored copy of an upstream file — the row a stop leaves
 *  in place, found by the mirror's own deterministic id. */
async function seedMirroredCopy(upstreamFileId: string, name: string): Promise<string> {
  const downstreamFileId = deterministicDownstreamFileId(DOWN, upstreamFileId)
  await seedFile(DOWN, downstreamFileId, name)
  return downstreamFileId
}

/** One translated, validated target cell on a mirrored copy — the work a stop
 *  must not touch (the alternative before this slice was deleting the file). */
async function seedTranslatedCell(downstreamFileId: string): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at, validated)
     VALUES (?, ?, 'MRK 1:1', 'target', 'Ang simula', 'e-target-1', 2000, 1)`,
  )
    .bind(DOWN, downstreamFileId)
    .run()
}

async function setLink(opts: { mode?: string | null; fileIds?: string[] | null } = {}): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `UPDATE projects
        SET source_project_id = ?, source_link_mode = ?, source_link_consumes = 'source',
            source_link_gate = 'validated', source_link_cursor = 40,
            source_link_file_ids = ?
      WHERE id = ?`,
  )
    .bind(
      UP,
      opts.mode === undefined ? "live" : opts.mode,
      opts.fileIds === undefined ? JSON.stringify([MAT, MRK]) : opts.fileIds && JSON.stringify(opts.fileIds),
      DOWN,
    )
    .run()
}

async function selection(): Promise<string[] | null> {
  const row = await env.AQUILLA_PG.prepare("SELECT source_link_file_ids FROM projects WHERE id = ?")
    .bind(DOWN)
    .first<{ source_link_file_ids: string | null }>()
  return parseLinkFileIds(row?.source_link_file_ids ?? null)
}

async function stopFiles(fileIds: unknown, as = "lead"): Promise<Response> {
  return app.request(
    `/api/v2/projects/${DOWN}/link-source/files/stop`,
    { method: "POST", headers: authHeader(await jwtFor(as)), body: JSON.stringify({ fileIds }) },
    env,
  )
}

async function getFiles(as = "lead"): Promise<Response> {
  return app.request(
    `/api/v2/projects/${DOWN}/link-source/files`,
    { headers: authHeader(await jwtFor(as)) },
    env,
  )
}

beforeEach(async () => {
  await seedUser(1, "lead")
  await seedUser(2, "contributor")
  await seedUser(3, "upstream-owner")
  await seedProject(DOWN, "Team C", 1)
  await seedProject(UP, "Gospels", 3)
  await addMember(DOWN, 1, 500)
  await addMember(UP, 1, 100)
  await addMember(DOWN, 2, 300)
  await seedFile(UP, MAT, "MAT.usfm")
  await seedFile(UP, MRK, "MRK.usfm")
  await seedFile(UP, LUK, "LUK.usfm")
  await setLink()
})

describe("POST /:projectId/link-source/files/stop (AQU-1562)", () => {
  // WHY: the slice's whole point — "what used to require deleting the file or
  // detaching the whole project now works for one file". The selection loses
  // MRK; MRK itself, and the validated translation on it, are untouched.
  it("narrows the selection and leaves the file and its translations in place", async () => {
    const mirrored = await seedMirroredCopy(MRK, "MRK.usfm")
    await seedTranslatedCell(mirrored)

    const res = await stopFiles([MRK])

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      projectId: DOWN,
      stopped: [MRK],
      fileIds: [MAT],
      wasWholeProject: false,
    })
    expect(await selection()).toEqual([MAT])
    const file = await env.AQUILLA_PG.prepare(
      "SELECT name, deleted_at FROM files WHERE id = ? AND project_id = ?",
    )
      .bind(mirrored, DOWN)
      .first<{ name: string; deleted_at: string | null }>()
    expect(file).toMatchObject({ name: "MRK.usfm", deleted_at: null })
    const cell = await env.AQUILLA_PG.prepare(
      "SELECT value, validated FROM cells WHERE project_id = ? AND file_id = ?",
    )
      .bind(DOWN, mirrored)
      .first<{ value: string; validated: number }>()
    expect(cell).toMatchObject({ value: "Ang simula", validated: 1 })
  })

  // WHY: AQU-1559's rule, from the other direction. A whole-project link has no
  // list to take a file out of, so it becomes the fixed list of the rest — which
  // is exactly why the confirm has to warn that the upstream's later files will
  // stop arriving on their own. `wasWholeProject` is what tells the client to
  // say it.
  it("pins a whole-project link to the remaining upstream files", async () => {
    await setLink({ fileIds: null })

    const res = await stopFiles([MRK])

    expect(await res.json()).toEqual({
      projectId: DOWN,
      stopped: [MRK],
      fileIds: [MAT, LUK],
      wasWholeProject: true,
    })
    expect(await selection()).toEqual([MAT, LUK])
  })

  // WHY: "unchecking every linked file cannot be confirmed … points to Detach
  // from source". A link following no files could never sync, and detaching is
  // a different operation — it snapshots the upstream first. Refused on both
  // shapes of link, and nothing is written.
  it("refuses to empty the selection, on a fixed list and on a whole-project link", async () => {
    const fixed = await stopFiles([MAT, MRK])
    expect(fixed.status).toBe(409)
    expect(await fixed.text()).toContain("detach-source")
    expect(await selection()).toEqual([MAT, MRK])

    await setLink({ fileIds: null })
    const whole = await stopFiles([MAT, MRK, LUK])
    expect(whole.status).toBe(409)
    expect(await selection()).toBeNull()
  })

  // WHY: other followed files are unaffected — the operation is per file, and a
  // second stop of the same file is the no-op it looks like rather than an
  // error the client has to special-case.
  it("leaves the other followed files alone, and stopping twice changes nothing", async () => {
    await stopFiles([MRK])

    const again = await stopFiles([MRK])

    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({
      projectId: DOWN,
      stopped: [],
      fileIds: [MAT],
      wasWholeProject: false,
    })
    expect(await selection()).toEqual([MAT])
  })

  // WHY: an id the link does not follow — never picked, or gone from the
  // upstream since the client read the list — is dropped rather than refused,
  // the same posture as adding files.
  it("ignores files the link does not follow", async () => {
    const res = await stopFiles([LUK, "file-not-upstream"])

    expect(await res.json()).toMatchObject({ stopped: [], fileIds: [MAT, MRK] })
    expect(await selection()).toEqual([MAT, MRK])
  })

  // WHY: "a Contributor or Viewer cannot stop a file" — the same floor as
  // detach, enforced here whatever the client shows.
  it("refuses a Contributor", async () => {
    const res = await stopFiles([MRK], "contributor")

    expect(res.status).toBe(403)
    expect(await selection()).toEqual([MAT, MRK])
  })

  // WHY: deliberately NOT the add route's rule. Stopping copies nothing in — it
  // only reduces what this project takes — and a lead who has lost access to
  // the upstream is exactly the person who needs to stop following it. Detach,
  // the whole-project version, has never re-checked either.
  it("allows a lead who can no longer see the upstream", async () => {
    await env.AQUILLA_PG.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = 1")
      .bind(UP)
      .run()

    const res = await stopFiles([MRK])

    expect(res.status).toBe(200)
    expect(await selection()).toEqual([MAT])
  })

  // WHY: a clone never syncs and a legacy link with no recorded mode is not
  // mirrored, so neither has a per-file flow of changes to stop.
  it("refuses a clone, a legacy link, and a project with no link", async () => {
    for (const mode of ["clone", null]) {
      await setLink({ mode })
      expect((await stopFiles([MRK])).status).toBe(409)
      expect(await selection()).toEqual([MAT, MRK])
    }
    await env.AQUILLA_PG.prepare("UPDATE projects SET source_project_id = NULL WHERE id = ?").bind(DOWN).run()
    expect((await stopFiles([MRK])).status).toBe(409)
  })

  it("refuses an empty list", async () => {
    expect((await stopFiles([])).status).toBe(400)
  })

  // WHY: this worker is deployed independently of migration 0127. Without the
  // column there is nowhere to record a narrowed selection, which is said
  // rather than silently answering as though the file had been stopped.
  describe("on a database that predates the selection column", () => {
    beforeEach(async () => {
      await env.AQUILLA_PG.prepare("ALTER TABLE projects DROP COLUMN IF EXISTS source_link_file_ids").run()
    })
    afterEach(async () => {
      await env.AQUILLA_PG.prepare("ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_link_file_ids TEXT").run()
    })

    it("refuses to stop a file", async () => {
      expect((await stopFiles([MRK])).status).toBe(503)
    })
  })
})

describe("GET /:projectId/link-source/files (AQU-1562)", () => {
  // WHY: the two confirms differ, and the rows do not. A stopped file is here
  // with its translations, so following it again REPLACES its source text;
  // a file this project never had is only brought in. The server tells them
  // apart by the mirror's own file identity, not by name — a stopped file can
  // be renamed on either side.
  it("reports what the link follows and which unfollowed files are stopped here", async () => {
    await seedMirroredCopy(MRK, "MRK.usfm")
    await setLink({ fileIds: [MAT] })

    const res = await getFiles()

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ projectId: DOWN, fileIds: [MAT], stoppedFileIds: [MRK] })
  })

  // WHY: a file the project imported itself carries a random UUID, which the
  // deterministic mirror id can never collide with — so sharing a name with an
  // upstream file does not make it a stopped copy.
  it("does not report a same-named file the project imported itself", async () => {
    await seedFile(DOWN, "local-mrk-uuid", "MRK.usfm")
    await setLink({ fileIds: [MAT] })

    expect(await (await getFiles()).json()).toMatchObject({ stoppedFileIds: [] })
  })

  // WHY: a whole-project link follows every file, so it has stopped none.
  it("reports nothing stopped on a whole-project link", async () => {
    await seedMirroredCopy(MRK, "MRK.usfm")
    await setLink({ fileIds: null })

    expect(await (await getFiles()).json()).toEqual({
      projectId: DOWN,
      fileIds: null,
      stoppedFileIds: [],
    })
  })

  it("refuses a Contributor and a project with no link", async () => {
    expect((await getFiles("contributor")).status).toBe(403)
    await env.AQUILLA_PG.prepare("UPDATE projects SET source_project_id = NULL WHERE id = ?").bind(DOWN).run()
    expect((await getFiles()).status).toBe(409)
  })
})

describe("detach after stopping a file (AQU-1562)", () => {
  // WHY: "'Detach from source' after stopping a file leaves the stopped file
  // exactly as it was — it is not overwritten with the upstream's current text
  // and no second copy is added." Detach snapshots the upstream into the files
  // the LINK followed, and a stopped file is no longer one of them, so the
  // narrowed selection is the whole mechanism. The alternative would hand a team
  // that deliberately took one book its own way the upstream's text back.
  it("leaves a stopped file alone and adds no second copy", async () => {
    const mirroredMrk = await seedMirroredCopy(MRK, "MRK.usfm")
    const mirroredMat = await seedMirroredCopy(MAT, "MAT.usfm")
    // The upstream has moved on in both files since the stop.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at) VALUES
         (?, ?, 'c1', 'source', 'UPSTREAM Mark, revised', 'e-up-mrk-c1', 3000),
         (?, ?, 'c1', 'source', 'UPSTREAM Matthew, revised', 'e-up-mat-c1', 3000)`,
    )
      .bind(UP, MRK, UP, MAT)
      .run()
    // What this project holds in each mirrored copy right now.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at) VALUES
         (?, ?, 'c1', 'source', 'Mark as it was when stopped', 'e-mrk-c1', 2000),
         (?, ?, 'c1', 'source', 'Matthew, old', 'e-mat-c1', 2000)`,
    )
      .bind(DOWN, mirroredMrk, DOWN, mirroredMat)
      .run()

    expect((await stopFiles([MRK])).status).toBe(200)
    const detached = await app.request(
      `/api/v2/projects/${DOWN}/detach-source`,
      { method: "POST", headers: authHeader(await jwtFor("lead")) },
      env,
    )

    expect(detached.status).toBe(200)
    // The stopped file kept the text it had when it was stopped.
    const mrkCell = await env.AQUILLA_PG.prepare(
      "SELECT value FROM cells WHERE project_id = ? AND file_id = ? AND cell_id = 'c1' AND side = 'source'",
    )
      .bind(DOWN, mirroredMrk)
      .first<{ value: string }>()
    expect(mrkCell?.value).toBe("Mark as it was when stopped")
    // The still-followed file took the snapshot, which is detach working.
    const matCell = await env.AQUILLA_PG.prepare(
      "SELECT value FROM cells WHERE project_id = ? AND file_id = ? AND cell_id = 'c1' AND side = 'source'",
    )
      .bind(DOWN, mirroredMat)
      .first<{ value: string }>()
    expect(matCell?.value).toBe("UPSTREAM Matthew, revised")
    // And no second MRK was added beside it.
    const mrkFiles = await env.AQUILLA_PG.prepare(
      "SELECT id FROM files WHERE project_id = ? AND name LIKE 'MRK%' AND deleted_at IS NULL",
    )
      .bind(DOWN)
      .all<{ id: string }>()
    expect(mrkFiles.results?.map((r) => r.id)).toEqual([mirroredMrk])
  })
})
