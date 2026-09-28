// AQU-1092…1098: GET /api/v1/projects/:projectId/plan
//
// The board's whole data contract: which rows are units at all, what progress
// each carries for the lane being viewed, and what the manager has planned.
import { describe, it, expect } from "vitest"
import { handlePlanRequest, type PlanResponse } from "../events/plan-route"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"
import type { AquillaDb } from "../../../db/shim/postgres"

const SECRET = "plan-read-secret"
const P = "proj-a"
const TS = 1_700_000_000_000

function envWith(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
}

function file(id: string, over: Record<string, unknown> = {}) {
  return {
    id, project_id: P, name: id, file_type: "codex",
    event_id: `ev-${id}`, cell_count: 0, approved_count: 0, word_count: 0,
    ...over,
  }
}

function progress(fileId: string, scope: string, key: string, over: Record<string, unknown> = {}) {
  return {
    project_id: P, file_id: fileId, scope, section_key: key, target_lang: "",
    total_count: 0, filled_count: 0, validator_histogram: "{}",
    // AQU-490: audioValidatedCount is read from this histogram at the
    // project's threshold, not from the stored column beside it — a stored
    // verdict is fixed at "one vote" and would contradict the board the
    // moment a project asked for two.
    audio_count: 0, audio_validated_count: 0, audio_validator_histogram: "{}",
    last_edit_at: null,
    revision: 5, updated_at: TS,
    ...over,
  }
}

async function get(db: AquillaDb, opts: { lane?: string; role?: number; headers?: Record<string, string> } = {}) {
  const token = await makeTestToken(SECRET, { projectId: P, role: opts.role ?? 400 })
  const url = `https://sync.test/api/v1/projects/${P}/plan${opts.lane ? `?lane=${opts.lane}` : ""}`
  const res = await handlePlanRequest(
    new Request(url, { headers: { Authorization: `Bearer ${token}`, ...(opts.headers ?? {}) } }),
    envWith(db),
  )
  return res!
}

describe("GET .../plan — which rows are units", () => {
  it("gives a Scripture file one unit per book and no file-grain unit", async () => {
    // The file dissolves into its books. Showing the file as a sibling row
    // would double-count it in every summary.
    const { db } = await makeTestDb({
      files: [file("bible", { name: "Whole Bible" })],
      file_section_progress: [
        progress("bible", "file", "", { total_count: 40 }),
        progress("bible", "book", "GEN", { total_count: 25 }),
        progress("bible", "book", "EXO", { total_count: 15 }),
      ],
    })
    const body = (await (await get(db)).json()) as PlanResponse
    expect(body.units.map((u) => u.sectionKey)).toEqual(["GEN", "EXO"])
    expect(body.units.every((u) => u.fileId === "bible")).toBe(true)
  })

  it("gives a non-Scripture file exactly one file-grain unit", async () => {
    const { db } = await makeTestDb({
      files: [file("ep1", { name: "Episode 1" })],
      file_section_progress: [progress("ep1", "file", "", { total_count: 12, filled_count: 6 })],
    })
    const body = (await (await get(db)).json()) as PlanResponse
    expect(body.units).toHaveLength(1)
    expect(body.units[0]).toMatchObject({ fileId: "ep1", sectionKey: "", totalCount: 12, filledCount: 6 })
  })

  it("excludes tombstoned files and audio-cue siblings", async () => {
    // The cue sibling is a hidden companion the audio workflow creates; nobody
    // plans it, and it never appears in a file list either.
    const { db } = await makeTestDb({
      files: [
        file("live"),
        file("gone", { deleted_at: TS }),
        file("cues", { role: "audio-cues" }),
      ],
      file_section_progress: [
        progress("live", "file", ""),
        progress("gone", "file", ""),
        progress("cues", "file", ""),
      ],
    })
    const body = (await (await get(db)).json()) as PlanResponse
    expect(body.units.map((u) => u.fileId)).toEqual(["live"])
  })

  it("orders books canonically and unknown units after them", async () => {
    const { db } = await makeTestDb({
      files: [file("bible"), file("zz-notes", { name: "Appendix" })],
      file_section_progress: [
        progress("bible", "book", "EXO"),
        progress("bible", "book", "GEN"),
        progress("zz-notes", "file", ""),
      ],
    })
    const body = (await (await get(db)).json()) as PlanResponse
    expect(body.units.map((u) => u.sectionKey || u.fileName)).toEqual(["GEN", "EXO", "Appendix"])
  })

  it("orders one-book files by their book_code, not their name", async () => {
    const { db } = await makeTestDb({
      files: [file("f-exo", { name: "Exodus", book_code: "EXO" }), file("f-gen", { name: "Genesis", book_code: "GEN" })],
      file_section_progress: [progress("f-exo", "file", ""), progress("f-gen", "file", "")],
    })
    const body = (await (await get(db)).json()) as PlanResponse
    expect(body.units.map((u) => u.fileName)).toEqual(["Genesis", "Exodus"])
  })
})

describe("GET .../plan — lane behaviour", () => {
  it("reads the requested lane's progress", async () => {
    const { db } = await makeTestDb({
      files: [file("f1")],
      file_section_progress: [
        progress("f1", "file", "", { total_count: 10, filled_count: 0 }),
        progress("f1", "file", "", { target_lang: "es", total_count: 10, filled_count: 7 }),
      ],
    })
    const body = (await (await get(db, { lane: "es" })).json()) as PlanResponse
    expect(body.lane).toBe("es")
    expect(body.units[0].filledCount).toBe(7)
  })

  it("reports zero progress for a lane nobody has started, not another lane's", async () => {
    // Borrowing the default lane's filled count would claim French work that
    // does not exist. The denominator is shared; the progress is not.
    const { db } = await makeTestDb({
      files: [file("f1")],
      file_section_progress: [
        progress("f1", "file", "", { total_count: 10, filled_count: 9, audio_count: 4, last_edit_at: 999 }),
      ],
    })
    const body = (await (await get(db, { lane: "fr" })).json()) as PlanResponse
    expect(body.units[0]).toMatchObject({
      totalCount: 10,   // lane-independent — falls back
      filledCount: 0,   // lane-specific — does not
      audioCount: 4,    // lane-independent — audio hangs off the cell
      lastEditAt: 999,
    })
  })

  it("falls back to the file's cell_count when no projection row exists yet", async () => {
    // Mid-backfill, or a file imported before the projection existed.
    const { db } = await makeTestDb({ files: [file("f1", { cell_count: 33 })] })
    const body = (await (await get(db)).json()) as PlanResponse
    expect(body.units[0]).toMatchObject({ totalCount: 33, filledCount: 0 })
  })
})

describe("GET .../plan — validation and plan data", () => {
  it("counts validated against the project's validation threshold", async () => {
    const { db } = await makeTestDb({
      files: [file("f1")],
      project_settings: [{ project_id: P, settings: JSON.stringify({ validationCount: 2 }), version: 1, updated_at: TS }],
      file_section_progress: [
        // Three cells endorsed once, two endorsed twice.
        progress("f1", "file", "", { total_count: 5, filled_count: 5, validator_histogram: JSON.stringify({ "1": 3, "2": 2 }) }),
      ],
    })
    const body = (await (await get(db)).json()) as PlanResponse
    expect(body.validationCount).toBe(2)
    expect(body.units[0].validatedCount).toBe(2) // only the two that reached 2
  })

  it("carries the target date and Done provenance", async () => {
    const { db } = await makeTestDb({
      files: [file("f1")],
      file_section_progress: [progress("f1", "file", "")],
      plan_units: [{
        project_id: P, file_id: "f1", section_key: "",
        target_date: "2026-11-01", done_at: TS, done_by: "randall",
        updated_at: TS, updated_by: "randall",
      }],
    })
    const body = (await (await get(db)).json()) as PlanResponse
    expect(body.units[0]).toMatchObject({
      targetDate: "2026-11-01", doneAt: TS, doneBy: "randall", updatedBy: "randall",
    })
  })

  it("leaves plan fields null for an unplanned unit", async () => {
    const { db } = await makeTestDb({
      files: [file("f1")],
      file_section_progress: [progress("f1", "file", "")],
    })
    const body = (await (await get(db)).json()) as PlanResponse
    expect(body.units[0]).toMatchObject({ targetDate: null, doneAt: null, doneBy: null })
  })
})

describe("GET .../plan — caching and auth", () => {
  it("answers 304 when the caller already has the current plan", async () => {
    const { db } = await makeTestDb({
      files: [file("f1")],
      file_section_progress: [progress("f1", "file", "")],
    })
    const first = await get(db)
    const etag = first.headers.get("ETag")!
    expect(etag).toBeTruthy()
    const second = await get(db, { headers: { "If-None-Match": etag } })
    expect(second.status).toBe(304)
  })

  it("changes the ETag when a plan is edited, though no event was written", async () => {
    // Plan writes never advance the event sequence, so a revision-only ETag
    // would serve a stale board forever after a date change.
    const { db } = await makeTestDb({
      files: [file("f1")],
      file_section_progress: [progress("f1", "file", "")],
    })
    const before = (await get(db)).headers.get("ETag")
    await db
      .prepare(`INSERT INTO plan_units (project_id, file_id, section_key, target_date, updated_at)
                VALUES (?, 'f1', '', '2026-11-01', ?)`)
      .bind(P, TS + 1)
      .run()
    expect((await get(db)).headers.get("ETag")).not.toBe(before)
  })

  it("carries a shape marker, so a body cached before a shape change is not 304'd", async () => {
    // AQU-1278. Every other part of this key is a property of the DATA, so
    // when only the response SHAPE moves — this branch added audioTotalCount,
    // corpusMarker and fileBookCode to every unit — nothing else in the key
    // moves with it. A browser holding a body from the previous shape would
    // revalidate, be told 304, and keep serving it: a dubbing project
    // measured against its subtitle count, every file in one folder. Both
    // progress ETags have carried a shape marker since AQU-1098 for exactly
    // this; this one did not until the fields landed.
    //
    // Asserting the MARKER rather than the whole string on purpose: the key's
    // other components are free to change, and a test that pinned all of them
    // would fail on every one of those changes without saying anything.
    const { db } = await makeTestDb({
      files: [file("f1")],
      file_section_progress: [progress("f1", "file", "")],
    })
    const etag = (await get(db)).headers.get("ETag")!
    expect(etag).toContain(":s3")

    // And the marker is load-bearing: a caller holding the same key from
    // before the shape changed does NOT get a 304.
    const previousShape = etag.replace(":s3", "")
    expect(previousShape).not.toBe(etag)
    const res = await get(db, { headers: { "If-None-Match": previousShape } })
    expect(res.status).toBe(200)

    // AQU-490: nor does one from the shape immediately before this — the live
    // case at deploy. audioValidatedCount kept its name and its type and
    // changed its question, which nothing else in the key can express.
    const s2Era = etag.replace(":va1:s3", ":s2")
    expect(s2Era).not.toBe(etag)
    expect((await get(db, { headers: { "If-None-Match": s2Era } })).status).toBe(200)
  })

  it("moves when the validation threshold or the headings policy changes", async () => {
    // Both change every number on the board without touching a single row
    // this ETag's clocks watch: validatedCount is derived from the histogram
    // against the threshold at READ time, and the structural subtraction is
    // applied at read time too. Each therefore has its own tag in the key —
    // v<N> and :nostruct — and losing either would hand a 304 to a client
    // whose numbers all just changed.
    const { db } = await makeTestDb({
      // The headings policy is resolved FROM the project row (a query driven
      // from project_settings would hide every project that inherits), so the
      // project and its org must exist for the policy to be readable at all.
      organizations: [{ id: 1, name: "Org", owner_user_id: 1 }],
      projects: [{ id: P, name: "Plan", org_id: 1 }],
      org_settings: [{ org_id: 1, settings: "{}", version: 1 }],
      files: [file("f1")],
      project_settings: [{ project_id: P, settings: JSON.stringify({ validationCount: 1 }), version: 1, updated_at: TS }],
      file_section_progress: [progress("f1", "file", "")],
    })
    const first = (await get(db)).headers.get("ETag")!

    await db.prepare("UPDATE project_settings SET settings = ? WHERE project_id = ?")
      .bind(JSON.stringify({ validationCount: 2 }), P).run()
    const raised = (await get(db)).headers.get("ETag")!
    expect(raised).not.toBe(first)
    expect((await get(db, { headers: { "If-None-Match": first } })).status).toBe(200)

    await db.prepare("UPDATE project_settings SET settings = ? WHERE project_id = ?")
      .bind(JSON.stringify({ validationCount: 2, countStructuralCells: false }), P).run()
    const excluded = (await get(db)).headers.get("ETag")!
    expect(excluded).not.toBe(raised)
    expect(excluded).toContain(":nostruct")
    expect((await get(db, { headers: { "If-None-Match": raised } })).status).toBe(200)

    // AQU-490: and the AUDIO threshold, for the same reason. Every unit's
    // audioValidatedCount is read from the audio histogram against it, so
    // raising it changes the board with no data write to move any clock.
    await db.prepare("UPDATE project_settings SET settings = ? WHERE project_id = ?")
      .bind(JSON.stringify({ validationCount: 2, countStructuralCells: false, validationCountAudio: 2 }), P).run()
    const audioRaised = (await get(db)).headers.get("ETag")!
    expect(audioRaised).not.toBe(excluded)
    expect(audioRaised).toContain(":va2:")
    expect((await get(db, { headers: { "If-None-Match": excluded } })).status).toBe(200)
  })

  it("moves when a cue sheet is REMOVED, which changes every audio number", async () => {
    // The unit's audio pair and its denominator are read off the sheet, and
    // whether there IS a sheet is decided from the files table — but the
    // clocks folded only projection rows, and a cue file is excluded from the
    // unit set, so its own row reached nothing. Tombstoning a sheet flipped
    // audioTotalCount to null and the counts back to the anchor's zeroes while
    // the ETag stayed byte-identical, and the board went on serving the
    // numbers of a sheet that no longer existed.
    const { db } = await makeTestDb({
      files: [
        file("ep1", { cell_count: 120 }),
        file("ep1-cues", {
          role: "audio-cues", kind: "vtt", anchor_file_id: "ep1",
          cell_count: 100, updated_at: TS,
        }),
      ],
      file_section_progress: [
        progress("ep1", "file", "", { total_count: 120, filled_count: 120 }),
        progress("ep1-cues", "file", "", { total_count: 100, audio_count: 90 }),
      ],
    })
    const before = await get(db)
    const beforeEtag = before.headers.get("ETag")!
    expect(((await before.json()) as PlanResponse).units[0]).toMatchObject({
      audioTotalCount: 100, audioCount: 90,
    })

    await db.prepare("UPDATE files SET deleted_at = ?, updated_at = ? WHERE id = ?")
      .bind(TS + 1000, TS + 1000, "ep1-cues").run()

    const after = await get(db)
    expect(((await after.json()) as PlanResponse).units[0]).toMatchObject({
      audioTotalCount: null, audioCount: 0,
    })
    expect(after.headers.get("ETag")).not.toBe(beforeEtag)
    // And the stale key is no longer honoured.
    expect((await get(db, { headers: { "If-None-Match": beforeEtag } })).status).toBe(200)
  })

  it("refuses a request with no token", async () => {
    const { db } = await makeTestDb({ files: [file("f1")] })
    const res = await handlePlanRequest(new Request(`https://sync.test/api/v1/projects/${P}/plan`), envWith(db))
    expect(res!.status).toBe(401)
  })

  it("refuses a token minted for another project", async () => {
    const { db } = await makeTestDb({ files: [file("f1")] })
    const token = await makeTestToken(SECRET, { projectId: "other", role: 600 })
    const res = await handlePlanRequest(
      new Request(`https://sync.test/api/v1/projects/${P}/plan`, { headers: { Authorization: `Bearer ${token}` } }),
      envWith(db),
    )
    expect(res!.status).toBe(403)
  })

  it("lets a viewer read the plan", async () => {
    const { db } = await makeTestDb({ files: [file("f1")] })
    expect((await get(db, { role: 100 })).status).toBe(200)
  })
})

describe("the ETag samples every clock that can change the board", () => {
  it("changes when a backfill fills in audio without any new event", async () => {
    // A progress recompute advances neither the event sequence nor
    // plan_units.updated_at, so an ETag built from those two alone stayed
    // byte-identical while the numbers underneath it changed — and a client
    // holding an audio-less board would 304 onto it forever.
    const db = await makeTestDb({
      files: [file("f1", { cell_count: 10 })],
      file_section_progress: [progress("f1", "file", "", { total_count: 10, filled_count: 4 })],
    }).then((r) => r.db)

    const before = await get(db)
    const tag = before.headers.get("ETag")!
    expect((await get(db, { headers: { "If-None-Match": tag } })).status).toBe(304)

    await db.prepare(
      `UPDATE file_section_progress SET audio_count = 5, updated_at = updated_at + 1000
        WHERE project_id = ? AND file_id = ?`,
    ).bind(P, "f1").run()

    const after = await get(db, { headers: { "If-None-Match": tag } })
    expect(after.status).toBe(200)
    expect(after.headers.get("ETag")).not.toBe(tag)
    expect((await after.json() as PlanResponse).units[0].audioCount).toBe(5)
  })
})

// AQU-1278. The board is the surface the 110% was visible on: a dubbed book
// whose chapter headings were read aloud, in a project that does not count
// headings. Audio used to be copied straight off the row here, around `counts()`
// rather than through it, so the policy reached the cells and not the takes.
describe("the headings policy reaches the audio numbers too", () => {
  /** A 12-cell book: 10 verses and 2 headings, every one of them recorded. */
  async function dubbedBook(countStructural: boolean | undefined) {
    const { db } = await makeTestDb({
      organizations: [{ id: 1, name: "Org", owner_user_id: 1 }],
      projects: [{ id: P, name: "Plan", org_id: 1 }],
      org_settings: [{ org_id: 1, settings: "{}", version: 1 }],
      project_settings: [{
        project_id: P,
        settings: JSON.stringify(
          countStructural === undefined ? {} : { countStructuralCells: countStructural },
        ),
        version: 1,
        updated_at: TS,
      }],
      files: [file("f1", { book_code: "MRK" })],
      file_section_progress: [
        progress("f1", "book", "MRK", {
          total_count: 12, filled_count: 12,
          validator_histogram: JSON.stringify({ "1": 12 }),
          structural_count: 2, structural_filled_count: 2,
          structural_validator_histogram: JSON.stringify({ "1": 2 }),
          audio_count: 12, audio_validated_count: 12,
          audio_validator_histogram: JSON.stringify({ "1": 12 }),
          structural_audio_count: 2, structural_audio_validated_count: 2,
          structural_audio_validator_histogram: JSON.stringify({ "1": 2 }),
        }),
      ],
    })
    const body = (await (await get(db)).json()) as PlanResponse
    return body.units.find((u) => u.sectionKey === "MRK")!
  }

  it("counts recorded headings while the project counts headings", async () => {
    expect(await dubbedBook(undefined)).toMatchObject({
      totalCount: 12, audioCount: 12, audioValidatedCount: 12,
    })
  })

  it("takes recorded headings out with the headings when the project opts out", async () => {
    // 10 and 10, never 10 and 12. The bar clamps at 100% either way, so the
    // symptom a reader sees is the READOUT beside it — "110/0%" — and a row
    // that calls itself nearly complete for having been over-recorded.
    expect(await dubbedBook(false)).toMatchObject({
      totalCount: 10, audioCount: 10, audioValidatedCount: 10,
    })
  })
})

// AQU-1278. Nothing in this file used to make a dubbing project's audio
// visible, because nothing in the SCHEMA does: the takes hang off a hidden
// cue sheet, the board correctly refuses to plan that sheet, and the subtitle
// file it anchors to has never held a take in its life. Every episode of The
// Chosen read 0% recorded on a board sitting six inches from the editor that
// was playing the recordings.
describe("audio comes from the linked cue sheet", () => {
  /** An episode and, unless `sheets` says otherwise, one cue sheet on it. */
  function dubbed(sheets: Array<Record<string, unknown>>) {
    return {
      files: [
        file("ep1", { name: "Episode 1", kind: "vtt", cell_count: 646 }),
        ...sheets.map((s) => file(String(s.id), {
          name: "Episode 1 · audio cues", kind: "vtt", role: "audio-cues",
          anchor_file_id: "ep1", ...s,
        })),
      ],
    }
  }

  it("reads the sheet's takes against the sheet's own cell count", async () => {
    // 646 subtitle cells, 548 cues, 548 takes. Measured against the subtitles
    // a fully dubbed episode reads 85% and never finishes.
    const { db } = await makeTestDb({
      ...dubbed([{ id: "cues1", cell_count: 548 }]),
      file_section_progress: [
        progress("ep1", "file", "", { total_count: 646, filled_count: 600 }),
        progress("cues1", "file", "", {
          total_count: 548, audio_count: 548, audio_validated_count: 12,
          // AQU-490: and the histogram it is read from — which on a dubbing
          // unit must come off the SHEET's row (ps), like the counts beside
          // it, and not the anchor's lane row.
          audio_validator_histogram: JSON.stringify({ "0": 536, "1": 12 }),
        }),
      ],
    })
    const body = (await (await get(db)).json()) as PlanResponse
    expect(body.units).toHaveLength(1)
    expect(body.units[0]).toMatchObject({
      fileId: "ep1",
      totalCount: 646,
      audioCount: 548,
      audioValidatedCount: 12,
      audioTotalCount: 548,
    })
  })

  it("says null, not zero, for a unit with no cue sheet", async () => {
    // Null is what tells the client to keep measuring audio against the text
    // total, which is what every unit in existence did before this.
    const { db } = await makeTestDb({
      files: [file("bk", { cell_count: 40 })],
      file_section_progress: [
        progress("bk", "file", "", { total_count: 40, audio_count: 9 }),
      ],
    })
    const body = (await (await get(db)).json()) as PlanResponse
    expect(body.units[0]).toMatchObject({ audioCount: 9, audioTotalCount: null })
  })

  it("declares audio expected on a sheet nobody has recorded into yet", async () => {
    // The sheet IS the declaration: somebody imported cues for this episode,
    // so the dubbing is planned. Zero takes out of 548, not "text-only".
    const { db } = await makeTestDb({
      ...dubbed([{ id: "cues1", cell_count: 548 }]),
      file_section_progress: [
        progress("ep1", "file", "", { total_count: 646 }),
        progress("cues1", "file", "", { total_count: 548 }),
      ],
    })
    const body = (await (await get(db)).json()) as PlanResponse
    expect(body.units[0]).toMatchObject({ audioCount: 0, audioTotalCount: 548 })
  })

  it("falls back to the sheet's cell_count before its projection row exists", async () => {
    const { db } = await makeTestDb({
      ...dubbed([{ id: "cues1", cell_count: 548 }]),
      file_section_progress: [progress("ep1", "file", "", { total_count: 646 })],
    })
    const body = (await (await get(db)).json()) as PlanResponse
    expect(body.units[0]).toMatchObject({ audioCount: 0, audioTotalCount: 548 })
  })

  it("never lets the anchor's own audio stand in for a sheet's", async () => {
    // A subtitle file with takes on it is not a shape the importer makes, but
    // if one existed those takes are not the dubbing: the sheet is what was
    // recorded, and an empty sheet means nothing has been.
    const { db } = await makeTestDb({
      ...dubbed([{ id: "cues1", cell_count: 548 }]),
      file_section_progress: [
        progress("ep1", "file", "", { total_count: 646, audio_count: 640 }),
        progress("cues1", "file", "", { total_count: 548, audio_count: 3 }),
      ],
    })
    const body = (await (await get(db)).json()) as PlanResponse
    expect(body.units[0]).toMatchObject({ audioCount: 3, audioTotalCount: 548 })
  })

  it("ignores a tombstoned sheet", async () => {
    const { db } = await makeTestDb({
      ...dubbed([{ id: "cues1", cell_count: 548, deleted_at: TS }]),
      file_section_progress: [
        progress("ep1", "file", "", { total_count: 646, audio_count: 4 }),
        progress("cues1", "file", "", { total_count: 548, audio_count: 548 }),
      ],
    })
    const body = (await (await get(db)).json()) as PlanResponse
    expect(body.units[0]).toMatchObject({ audioCount: 4, audioTotalCount: null })
  })

  it("takes the newest sheet when a re-import left two", async () => {
    // Ids are UUIDv7, so the greatest is the most recently minted — the same
    // rule the editor uses to pick a file's cue sibling.
    const { db } = await makeTestDb({
      ...dubbed([
        { id: "cues-a", cell_count: 100 },
        { id: "cues-b", cell_count: 548 },
      ]),
      file_section_progress: [
        progress("ep1", "file", "", { total_count: 646 }),
        progress("cues-a", "file", "", { total_count: 100, audio_count: 100 }),
        progress("cues-b", "file", "", { total_count: 548, audio_count: 7 }),
      ],
    })
    const body = (await (await get(db)).json()) as PlanResponse
    expect(body.units[0]).toMatchObject({ audioCount: 7, audioTotalCount: 548 })
  })

  it("leaves a BOOK unit alone — a sheet anchors to a file, not to a book", async () => {
    const { db } = await makeTestDb({
      files: [
        file("bible", { name: "Whole Bible" }),
        file("cues1", { role: "audio-cues", anchor_file_id: "bible", cell_count: 548 }),
      ],
      file_section_progress: [
        progress("bible", "book", "GEN", { total_count: 25, audio_count: 5 }),
        progress("cues1", "file", "", { total_count: 548, audio_count: 548 }),
      ],
    })
    const body = (await (await get(db)).json()) as PlanResponse
    expect(body.units[0]).toMatchObject({
      sectionKey: "GEN", audioCount: 5, audioTotalCount: null,
    })
  })

  it("changes the ETag when only the cue sheet's row moves", async () => {
    // Recording a take touches no row of the subtitle file. Without the
    // sheet's stamp in the ETag the board that now reads its audio from the
    // sheet would answer 304 to every request after the first one.
    const { db } = await makeTestDb({
      ...dubbed([{ id: "cues1", cell_count: 548 }]),
      file_section_progress: [
        progress("ep1", "file", "", { total_count: 646 }),
        progress("cues1", "file", "", { total_count: 548 }),
      ],
    })
    const tag = (await get(db)).headers.get("ETag")!
    expect((await get(db, { headers: { "If-None-Match": tag } })).status).toBe(304)

    await db.prepare(
      `UPDATE file_section_progress SET audio_count = 9, updated_at = updated_at + 1000
        WHERE project_id = ? AND file_id = 'cues1'`,
    ).bind(P).run()

    const after = await get(db, { headers: { "If-None-Match": tag } })
    expect(after.status).toBe(200)
    expect(((await after.json()) as PlanResponse).units[0].audioCount).toBe(9)
  })
})

// AQU-1278: the in-order arrangement groups by the files' sidebar folders,
// which live in files.meta and nowhere else.
describe("the unit carries its file's folder", () => {
  it("reads the corpus marker out of the file's meta, and the file's book code", async () => {
    const { db } = await makeTestDb({
      files: [
        file("ep1", { name: "Episode 1", meta: JSON.stringify({ corpusMarker: "Season 1", orderedBy: "time" }) }),
        file("gen", { name: "Genesis", book_code: "GEN", meta: "{}" }),
        file("bad", { name: "Broken", meta: "not json" }),
      ],
      file_section_progress: [
        progress("ep1", "file", ""), progress("gen", "file", ""), progress("bad", "file", ""),
      ],
    })
    const body = (await (await get(db)).json()) as PlanResponse
    const by = new Map(body.units.map((u) => [u.fileId, u]))
    expect(by.get("ep1")).toMatchObject({ corpusMarker: "Season 1", fileBookCode: null })
    expect(by.get("gen")).toMatchObject({ corpusMarker: null, fileBookCode: "GEN" })
    // A meta blob that will not parse names no folder, and breaks nothing.
    expect(by.get("bad")).toMatchObject({ corpusMarker: null })
  })

  it("changes the ETag when a file is moved to another folder", async () => {
    // A rename touches files.updated_at and nothing the other clocks watch.
    const { db } = await makeTestDb({
      files: [file("ep1", { meta: JSON.stringify({ corpusMarker: "Season 1" }), updated_at: TS })],
      file_section_progress: [progress("ep1", "file", "")],
    })
    const tag = (await get(db)).headers.get("ETag")!
    expect((await get(db, { headers: { "If-None-Match": tag } })).status).toBe(304)
    await db.prepare(
      `UPDATE files SET meta = ?, updated_at = ? WHERE project_id = ? AND id = 'ep1'`,
    ).bind(JSON.stringify({ corpusMarker: "Season 2" }), TS + 5000, P).run()
    const after = await get(db, { headers: { "If-None-Match": tag } })
    expect(after.status).toBe(200)
    expect(((await after.json()) as PlanResponse).units[0].corpusMarker).toBe("Season 2")
  })
})
