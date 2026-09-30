import { describe, expect, it } from "vitest"
import { handleCellsReadRequest } from "../events/cells-read-route"
import { handleProgressReadRequest } from "../events/progress-read-route"
import { makeTestToken } from "./helpers/auth"
import { makeTestDb } from "./helpers/pg-test-db"

const SECRET = "lane-wall-secret"
const PROJECT = "proj-wall"
const FILE = "file-wall"
const ES = "lane-es"
const FR = "lane-fr"
const DEFAULT = "lane-default"

function envWith(db: AquillaDb, wall: boolean) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, ...(wall ? { LANE_READ_WALL: "1" } : {}) }
}

describe("AQU-730 read wall", () => {
  it("hides ungranted target cells, keeps source, and stays off when the flag is unset", async () => {
    const { db } = await makeTestDb({
      lanes: [
        { id: ES, project_id: PROJECT, role: "target", name: "Spanish", lang_code: "es", legacy_tag: "es" },
        { id: FR, project_id: PROJECT, role: "target", name: "French", lang_code: "fr", legacy_tag: "fr" },
        { id: DEFAULT, project_id: PROJECT, role: "target", name: "Spanish", lang_code: "es", legacy_tag: "" },
      ],
      cells: [
        { project_id: PROJECT, file_id: FILE, cell_id: "s1", side: "source", event_id: "e-s", value: "source-text", target_lang: "" },
        { project_id: PROJECT, file_id: FILE, cell_id: "t1", side: "target", event_id: "e-es", value: "hola", target_lang: "es", lane_id: ES },
        { project_id: PROJECT, file_id: FILE, cell_id: "t1", side: "target", event_id: "e-fr", value: "bonjour", target_lang: "fr", lane_id: FR },
        { project_id: PROJECT, file_id: FILE, cell_id: "t1", side: "target", event_id: "e-def", value: "default-hola", target_lang: "", lane_id: DEFAULT },
      ],
    })
    const contributor = await makeTestToken(SECRET, {
      projectId: PROJECT,
      fileId: FILE,
      role: 400,
      laneGrants: [{ lane: ES, level: 400 }],
    })
    const walled = (await handleCellsReadRequest(
      new Request(`https://w/api/v1/projects/${PROJECT}/files/${FILE}/cells`, {
        headers: { Authorization: `Bearer ${contributor}` },
      }),
      envWith(db, true),
    ))!
    expect(walled.status).toBe(200)
    const walledBody = (await walled.json()) as { cells: Array<{ value: string }> }
    expect(walledBody.cells.map((c) => c.value).sort()).toEqual(["hola", "source-text"])

    const maintainer = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, role: 600 })
    const all = (await handleCellsReadRequest(
      new Request(`https://w/api/v1/projects/${PROJECT}/files/${FILE}/cells`, {
        headers: { Authorization: `Bearer ${maintainer}` },
      }),
      envWith(db, true),
    ))!
    const allBody = (await all.json()) as { cells: Array<{ value: string }> }
    expect(allBody.cells.map((c) => c.value).sort()).toEqual(["bonjour", "default-hola", "hola", "source-text"])

    const dark = (await handleCellsReadRequest(
      new Request(`https://w/api/v1/projects/${PROJECT}/files/${FILE}/cells`, {
        headers: { Authorization: `Bearer ${contributor}` },
      }),
      envWith(db, false),
    ))!
    const darkBody = (await dark.json()) as { cells: Array<{ value: string }> }
    expect(darkBody.cells.map((c) => c.value)).toContain("bonjour")

    const codeGrant = await makeTestToken(SECRET, {
      projectId: PROJECT,
      fileId: FILE,
      role: 400,
      laneGrants: [{ lane: "es", level: 100 }],
    })
    const byCode = (await handleCellsReadRequest(
      new Request(`https://w/api/v1/projects/${PROJECT}/files/${FILE}/cells`, {
        headers: { Authorization: `Bearer ${codeGrant}` },
      }),
      envWith(db, true),
    ))!
    const byCodeBody = (await byCode.json()) as { cells: Array<{ value: string }> }
    // A language code is not a grant. The id is.
    expect(byCodeBody.cells.map((c) => c.value).sort()).toEqual(["source-text"])
  })

  it("does not return another lane's progress to a contributor without that grant", async () => {
    const { db } = await makeTestDb({
      files: [{ id: FILE, project_id: PROJECT, name: "Genesis", event_id: "file-event" }],
      lanes: [
        { id: FR, project_id: PROJECT, role: "target", name: "French", lang_code: "fr", legacy_tag: "fr" },
        { id: DEFAULT, project_id: PROJECT, role: "target", name: "Spanish", lang_code: "es", legacy_tag: "" },
      ],
      file_section_progress: [
        {
          project_id: PROJECT, file_id: FILE, scope: "file", section_key: "",
          target_lang: "fr", lane_id: FR,
          total_count: 9, filled_count: 4, validator_histogram: {},
          revision: 1, updated_at: 1, audio_count: 0, audio_validated_count: 0,
        },
        {
          project_id: PROJECT, file_id: FILE, scope: "file", section_key: "",
          target_lang: "", lane_id: DEFAULT,
          total_count: 3, filled_count: 1, validator_histogram: {},
          revision: 1, updated_at: 1, audio_count: 0, audio_validated_count: 0,
        },
      ],
    })
    const token = await makeTestToken(SECRET, {
      projectId: PROJECT,
      fileId: FILE,
      role: 400,
      laneGrants: [{ lane: DEFAULT, level: 100 }],
    })
    const res = (await handleProgressReadRequest(
      new Request(`https://w/api/v1/projects/${PROJECT}/files/${FILE}/progress?lane=fr`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(db, true),
    ))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { file: { totalCount: number; filledCount: number } }
    expect(body.file.totalCount).toBe(0)
    expect(body.file.filledCount).toBe(0)

    const own = (await handleProgressReadRequest(
      new Request(`https://w/api/v1/projects/${PROJECT}/files/${FILE}/progress`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(db, true),
    ))!
    const ownBody = (await own.json()) as { file: { totalCount: number; filledCount: number } }
    expect(ownBody.file.totalCount).toBe(3)
    expect(ownBody.file.filledCount).toBe(1)
  })
})
