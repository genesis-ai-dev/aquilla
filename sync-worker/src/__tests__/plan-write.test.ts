// AQU-1094/1095: POST /api/v1/projects/:projectId/plan
//
// Setting a target date and marking a unit done are maintainer work — the
// per-unit analogue of the project deadline — so this suite is mostly about
// who may write, and about the patch semantics that keep a date edit from
// disturbing a Done mark and vice versa.
import { describe, it, expect } from "vitest"
import { handlePlanRequest, type PlanUnit } from "../events/plan-route"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"
import type { AquillaDb } from "../../../db/shim/postgres"

const SECRET = "plan-write-secret"
const P = "proj-a"
const TS = 1_700_000_000_000

function envWith(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

/** A project the caller is a member of, with one plannable file. */
async function seed(extra: Record<string, unknown[]> = {}) {
  return makeTestDb({
    projects: [{ id: P, name: "Tok Pisin", created_by: 1 }],
    project_members: [{ project_id: P, user_id: 1, role_level: 600 }],
    files: [
      { id: "f1", project_id: P, name: "Mark", file_type: "codex", event_id: "ev-f1", cell_count: 10 },
    ],
    file_section_progress: [
      {
        project_id: P, file_id: "f1", scope: "file", section_key: "", target_lang: "",
        total_count: 10, filled_count: 4, validator_histogram: "{}",
        audio_count: 0, audio_validated_count: 0, last_edit_at: null,
        revision: 3, updated_at: TS,
      },
    ],
    ...extra,
  })
}

async function post(
  db: AquillaDb,
  body: unknown,
  opts: { role?: number; userId?: number; username?: string; src?: string } = {},
) {
  const token = await makeTestToken(SECRET, {
    projectId: P,
    role: opts.role ?? 600,
    userId: opts.userId ?? 1,
    username: opts.username ?? "randall",
    ...(opts.src ? { src: opts.src } : {}),
  } as never)
  const res = await handlePlanRequest(
    new Request(`https://sync.test/api/v1/projects/${P}/plan`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    envWith(db),
  )
  return res!
}

async function planRow(db: AquillaDb) {
  return db
    .prepare(`SELECT target_date, done_at, done_by, updated_by FROM plan_units WHERE project_id = ? AND file_id = 'f1'`)
    .bind(P)
    .first<{ target_date: string | null; done_at: number | null; done_by: string | null; updated_by: string | null }>()
}

describe("who may write a plan", () => {
  it("refuses everyone below maintainer", async () => {
    const { db } = await seed()
    for (const role of [100, 400, 500]) {
      const res = await post(db, { fileId: "f1", sectionKey: "", targetDate: "2026-11-01" }, { role })
      expect(res.status, `role ${role}`).toBe(403)
    }
  })

  it("admits a maintainer", async () => {
    const { db } = await seed()
    expect((await post(db, { fileId: "f1", sectionKey: "", targetDate: "2026-11-01" })).status).toBe(200)
  })

  it("refuses a maintainer whose access was revoked since their token was minted", async () => {
    // A sync token carries its role for up to 15 minutes. Without the live
    // re-check, someone removed from the project keeps writing for that long.
    const { db } = await makeTestDb({
      projects: [{ id: P, name: "Tok Pisin", created_by: 99 }],
      files: [{ id: "f1", project_id: P, name: "Mark", file_type: "codex", event_id: "ev-f1", cell_count: 10 }],
    })
    const res = await post(db, { fileId: "f1", sectionKey: "", targetDate: "2026-11-01" }, { userId: 42 })
    expect(res.status).toBe(403)
    expect(await res.text()).toMatch(/membership revoked/)
  })

  it("exempts a platform operator, who has no membership rows to check", async () => {
    const { db } = await makeTestDb({
      projects: [{ id: P, name: "Tok Pisin", created_by: 99 }],
      files: [{ id: "f1", project_id: P, name: "Mark", file_type: "codex", event_id: "ev-f1", cell_count: 10 }],
    })
    const res = await post(db, { fileId: "f1", sectionKey: "", targetDate: "2026-11-01" }, { userId: 42, src: "platform" })
    expect(res.status).toBe(200)
  })
})

describe("what counts as a valid request", () => {
  it("rejects a malformed date", async () => {
    const { db } = await seed()
    for (const bad of ["2026-13-45", "2026/01/01", "01-01-2026", "tomorrow", ""]) {
      const res = await post(db, { fileId: "f1", sectionKey: "", targetDate: bad })
      expect(res.status, bad).toBe(400)
    }
  })

  it("rejects a date that looks right but is not a real day", async () => {
    const { db } = await seed()
    expect((await post(db, { fileId: "f1", sectionKey: "", targetDate: "2026-02-30" })).status).toBe(400)
  })

  it("rejects a request that asks for nothing", async () => {
    const { db } = await seed()
    const res = await post(db, { fileId: "f1", sectionKey: "" })
    expect(res.status).toBe(400)
    expect(await res.text()).toMatch(/nothing to update/)
  })

  it("rejects invalid JSON and a missing fileId", async () => {
    const { db } = await seed()
    expect((await post(db, "{not json")).status).toBe(400)
    expect((await post(db, { sectionKey: "", done: true })).status).toBe(400)
  })

  it("rejects a non-boolean done", async () => {
    const { db } = await seed()
    expect((await post(db, { fileId: "f1", sectionKey: "", done: "yes" })).status).toBe(400)
  })
})

describe("planning something that is not a unit", () => {
  it("refuses an unknown file, a tombstoned file and a cue sibling", async () => {
    const { db } = await makeTestDb({
      projects: [{ id: P, name: "x", created_by: 1 }],
      project_members: [{ project_id: P, user_id: 1, role_level: 600 }],
      files: [
        { id: "gone", project_id: P, name: "Gone", file_type: "codex", event_id: "e1", cell_count: 1, deleted_at: TS },
        { id: "cues", project_id: P, name: "Cues", file_type: "codex", event_id: "e2", cell_count: 1, role: "audio-cues" },
      ],
    })
    for (const fileId of ["nope", "gone", "cues"]) {
      expect((await post(db, { fileId, sectionKey: "", done: true })).status, fileId).toBe(404)
    }
  })

  it("refuses a file-grain write against a Scripture file, which plans by book", async () => {
    const { db } = await seed({
      file_section_progress: [
        { project_id: P, file_id: "f1", scope: "book", section_key: "MRK", target_lang: "",
          total_count: 10, filled_count: 4, validator_histogram: "{}",
          audio_count: 0, audio_validated_count: 0, last_edit_at: null, revision: 3, updated_at: TS },
      ],
    })
    expect((await post(db, { fileId: "f1", sectionKey: "", done: true })).status).toBe(404)
    expect((await post(db, { fileId: "f1", sectionKey: "MRK", done: true })).status).toBe(200)
  })

  it("refuses a book that is not in that file", async () => {
    const { db } = await seed({
      file_section_progress: [
        { project_id: P, file_id: "f1", scope: "book", section_key: "MRK", target_lang: "",
          total_count: 10, filled_count: 4, validator_histogram: "{}",
          audio_count: 0, audio_validated_count: 0, last_edit_at: null, revision: 3, updated_at: TS },
      ],
    })
    expect((await post(db, { fileId: "f1", sectionKey: "GEN", done: true })).status).toBe(404)
  })
})

describe("patch semantics", () => {
  it("records who marked a unit done, and when", async () => {
    const { db } = await seed()
    const res = await post(db, { fileId: "f1", sectionKey: "", done: true })
    const { unit } = (await res.json()) as { unit: PlanUnit }
    expect(unit.doneBy).toBe("randall")
    expect(unit.doneAt).toBeGreaterThan(0)
  })

  it("keeps the original provenance when someone marks it done again", async () => {
    // The mark answers "who decided this was finished". A second click by a
    // different maintainer should not quietly reassign that.
    const { db } = await seed()
    await post(db, { fileId: "f1", sectionKey: "", done: true })
    const first = await planRow(db)
    await post(db, { fileId: "f1", sectionKey: "", done: true }, { username: "someone-else" })
    const second = await planRow(db)
    expect(second!.done_by).toBe("randall")
    expect(second!.done_at).toBe(first!.done_at)
  })

  it("clears both halves of the mark when un-marked", async () => {
    const { db } = await seed()
    await post(db, { fileId: "f1", sectionKey: "", done: true })
    await post(db, { fileId: "f1", sectionKey: "", done: false })
    const row = await planRow(db)
    expect(row!.done_at).toBeNull()
    expect(row!.done_by).toBeNull()
  })

  it("does not disturb the Done mark when only the date changes", async () => {
    const { db } = await seed()
    await post(db, { fileId: "f1", sectionKey: "", done: true })
    await post(db, { fileId: "f1", sectionKey: "", targetDate: "2026-12-24" })
    const row = await planRow(db)
    expect(row!.target_date).toBe("2026-12-24")
    expect(row!.done_by).toBe("randall")
  })

  it("does not disturb the date when only the mark changes", async () => {
    const { db } = await seed()
    await post(db, { fileId: "f1", sectionKey: "", targetDate: "2026-12-24" })
    await post(db, { fileId: "f1", sectionKey: "", done: true })
    expect((await planRow(db))!.target_date).toBe("2026-12-24")
  })

  it("clears the date on an explicit null without touching anything else", async () => {
    const { db } = await seed()
    await post(db, { fileId: "f1", sectionKey: "", targetDate: "2026-12-24", done: true })
    await post(db, { fileId: "f1", sectionKey: "", targetDate: null })
    const row = await planRow(db)
    expect(row!.target_date).toBeNull()
    expect(row!.done_by).toBe("randall")
  })

  it("returns the unit it was asked about, not merely the first one", async () => {
    // Regression: the re-read appended its filter after a LEFT JOIN's ON
    // clause instead of a WHERE, so every unit came back and the caller took
    // row zero. A project with one file hid it; a whole-Bible file did not —
    // marking Luke done answered with Genesis.
    const { db } = await seed({
      file_section_progress: ["MRK", "LUK", "JHN"].map((book) => ({
        project_id: P, file_id: "f1", scope: "book", section_key: book, target_lang: "",
        total_count: 10, filled_count: 4, validator_histogram: "{}",
        audio_count: 0, audio_validated_count: 0, last_edit_at: null, revision: 3, updated_at: TS,
      })),
    })
    const res = await post(db, { fileId: "f1", sectionKey: "LUK", done: true })
    expect(res.status).toBe(200)
    const { unit } = (await res.json()) as { unit: PlanUnit }
    expect(unit.sectionKey).toBe("LUK")
    expect(unit.doneAt).toBeGreaterThan(0)

    // ...and only that unit was marked.
    const marked = await db
      .prepare(`SELECT section_key FROM plan_units WHERE project_id = ? AND done_at IS NOT NULL`)
      .bind(P)
      .all<{ section_key: string }>()
    expect((marked.results ?? []).map((r) => r.section_key)).toEqual(["LUK"])
  })

  it("returns the unit with its progress, not just the plan fields", async () => {
    const { db } = await seed()
    const res = await post(db, { fileId: "f1", sectionKey: "", targetDate: "2026-11-01" })
    const { unit } = (await res.json()) as { unit: PlanUnit }
    expect(unit).toMatchObject({ fileId: "f1", fileName: "Mark", totalCount: 10, filledCount: 4, targetDate: "2026-11-01" })
  })

  it("falls back to a user id when the token carries no username", async () => {
    const { db } = await seed()
    await post(db, { fileId: "f1", sectionKey: "", done: true }, { username: "" })
    expect((await planRow(db))!.done_by).toBe("user:1")
  })
})
