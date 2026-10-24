// @vitest-environment node
//
// AQU-2125. The SQL against real Postgres (PGlite): the candidate prefilter,
// the line query (the name lives on the SOURCE row), and the versioned write.
// The fold's own rules are tested on fixtures in
// src/lib/audio/character-cast.test.ts.
import { PGlite } from "@electric-sql/pglite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadProjectSettings, patchProjectSettingsShared } from "../db/shared/projects"
import { PostgresDb, type AquillaDb, type PgExecutor } from "../db/shim/postgres"
import { characterCastKey } from "../src/lib/audio/voices"
import type { ProjectTtsSettings, Voice } from "../src/lib/parsers/types"
import { listFoldCandidates, loadCastLines, planProjectFold } from "./cast-by-character-fold"

const SCHEMA = `
  CREATE TABLE project_settings (
    project_id TEXT PRIMARY KEY,
    settings   TEXT NOT NULL DEFAULT '{}',
    version    INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT now(),
    updated_by BIGINT,
    validation_count TEXT GENERATED ALWAYS AS ((settings::jsonb)->>'validationCount') STORED,
    validation_count_audio TEXT GENERATED ALWAYS AS ((settings::jsonb)->>'validationCountAudio') STORED
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    org_id BIGINT,
    source_project_id TEXT,
    source_link_mode TEXT,
    source_link_consumes TEXT,
    source_link_lane_id TEXT
  );
  CREATE TABLE lanes (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, role TEXT NOT NULL, language TEXT,
    name TEXT, lang_code TEXT, legacy_tag TEXT, position INTEGER, archived_at TIMESTAMPTZ,
    records_audio BOOLEAN NOT NULL DEFAULT false
  );
  CREATE TABLE org_settings (
    org_id   BIGINT PRIMARY KEY,
    settings TEXT NOT NULL DEFAULT '{}',
    validation_count TEXT GENERATED ALWAYS AS ((settings::jsonb)->>'validationCount') STORED,
    validation_count_audio TEXT GENERATED ALWAYS AS ((settings::jsonb)->>'validationCountAudio') STORED
  );
  CREATE TABLE cells (
    project_id TEXT NOT NULL, file_id TEXT NOT NULL, cell_id TEXT NOT NULL,
    side TEXT NOT NULL, metadata JSONB, sequence_index DOUBLE PRECISION,
    PRIMARY KEY (project_id, file_id, cell_id, side)
  );
`

function pgliteExecutor(pg: PGlite): PgExecutor {
  const wrap = (q: Pick<PGlite, "query" | "exec">): PgExecutor => ({
    async run(sql, params) {
      if (params.length === 0) {
        const last = (await q.exec(sql)).at(-1)
        return {
          rows: (last?.rows ?? []) as Record<string, unknown>[],
          rowCount: last?.affectedRows ?? last?.rows.length ?? 0,
        }
      }
      const r = await q.query<Record<string, unknown>>(sql, params as unknown[])
      return { rows: r.rows, rowCount: (r as { affectedRows?: number }).affectedRows ?? r.rows.length }
    },
    begin: (fn) => pg.transaction((tx) => fn(wrap(tx as unknown as PGlite))) as Promise<never>,
  })
  return wrap(pg)
}

const narrator: Voice = { id: "preset-narrator", name: "Narrator", color: "#475569", builtIn: true }
const jesus: Voice = { id: "v-jesus", name: "JESUS", color: "#0e7490" }
const peter: Voice = { id: "v-peter", name: "PETER", color: "#0d9488" }

let pg: PGlite
let db: AquillaDb

async function seedProject(id: string, name: string, tts: ProjectTtsSettings | undefined): Promise<void> {
  await pg.query(`INSERT INTO projects (id, name) VALUES ($1, $2)`, [id, name])
  await pg.query(`INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ($1, $2, 3, 1)`, [
    id,
    JSON.stringify(tts === undefined ? { validationCount: 2 } : { validationCount: 2, ttsSettings: tts }),
  ])
}

async function seedCell(projectId: string, fileId: string, cellId: string, side: "source" | "target", castName: string | null, seq: number): Promise<void> {
  await pg.query(
    `INSERT INTO cells (project_id, file_id, cell_id, side, metadata, sequence_index) VALUES ($1, $2, $3, $4, $5, $6)`,
    [projectId, fileId, cellId, side, castName === null ? null : JSON.stringify({ cast_name: castName }), seq],
  )
}

beforeEach(async () => {
  pg = new PGlite({ parsers: { 20: (v: string) => Number(v), 1700: (v: string) => Number(v) } })
  await pg.exec(SCHEMA)
  db = new PostgresDb(pgliteExecutor(pg)) as unknown as AquillaDb

  // "dubbing": two episodes cast line by line by the character sheet, one line
  // recast by hand, one line whose save never landed.
  const cast: Record<string, string> = {}
  for (const ep of ["ep1", "ep2"]) {
    for (let i = 0; i < 300; i++) {
      const id = `${ep}-c${i}`
      const who = i % 2 === 0 ? "JESUS" : "PETER"
      await seedCell("dubbing", ep, id, "source", ` ${who} `, i)
      await seedCell("dubbing", ep, id, "target", null, i)
      cast[id] = who === "JESUS" ? jesus.id : peter.id
    }
  }
  cast["ep1-c4"] = narrator.id
  delete cast["ep2-c10"]
  cast["no-character"] = jesus.id
  await seedProject("dubbing", "Come and See — Spanish", { voices: [narrator, jesus, peter], defaultVoiceId: narrator.id, castAssignments: cast })
  await seedProject("small", "Tagalog NT", { voices: [narrator, jesus], castAssignments: { a: jesus.id } })
  await seedProject("no-tts", "Never opened the Studio", undefined)
})

afterEach(async () => {
  await pg.close()
})

describe("listFoldCandidates", () => {
  it("finds projects with a big cast map, biggest first, and ignores the threshold for --only", async () => {
    expect((await listFoldCandidates(db)).map((r) => [r.project_id, r.entries])).toEqual([["dubbing", 600]])
    expect((await listFoldCandidates(db, { minEntries: 1 })).map((r) => r.project_id)).toEqual(["dubbing", "small"])
    expect((await listFoldCandidates(db, { onlyProject: "small" })).map((r) => r.project_id)).toEqual(["small"])
    expect(await listFoldCandidates(db, { onlyProject: "no-tts" })).toEqual([])
  })
})

describe("loadCastLines", () => {
  it("reads each line's character off its source row, trimmed, in document order", async () => {
    const lines = await loadCastLines(db, "dubbing")
    expect(lines).toHaveLength(600)
    expect(lines[0]).toEqual({ id: "ep1-c0", castName: "JESUS" })
    expect(lines[1]).toEqual({ id: "ep1-c1", castName: "PETER" })
  })
})

describe("planProjectFold + the versioned write", () => {
  it("folds to one entry per character, keeps the exception, and writes once", async () => {
    const plan = await planProjectFold(db, { project_id: "dubbing", project_name: "Come and See — Spanish" })
    expect(plan).not.toBeNull()
    expect(plan!.nextTts.castAssignments).toEqual({
      [characterCastKey("JESUS")]: jesus.id,
      [characterCastKey("PETER")]: peter.id,
      "ep1-c4": narrator.id,
      "no-character": jesus.id,
    })
    expect(plan!.report).toMatchObject({
      linesWithCharacter: 600,
      entriesBefore: 600,
      entriesAfter: 4,
      characterEntries: 2,
      droppedLineEntries: 598,
      newlyVoicedLines: 1,
      markedLines: 0,
      versionBefore: 3,
    })
    expect(plan!.report.settingsBytesAfter).toBeLessThan(plan!.report.settingsBytesBefore / 10)

    const written = await patchProjectSettingsShared(db, {
      projectId: "dubbing",
      ops: [{ key: "ttsSettings", value: plan!.nextTts }],
      ifMatchVersion: plan!.version,
      updatedBy: "0",
      registerLanes: false,
    })
    expect(written.status).toBe("ok")
    const after = await loadProjectSettings(db, "dubbing")
    expect(after.version).toBe(4)
    expect((after.settings.ttsSettings as ProjectTtsSettings).castAssignments).toEqual(plan!.nextTts.castAssignments)
    // A second pass finds nothing left to fold.
    expect(await planProjectFold(db, { project_id: "dubbing", project_name: null })).toBeNull()
  })

  it("holds the never-cast line voiceless when asked", async () => {
    const plan = await planProjectFold(db, { project_id: "dubbing", project_name: null }, { keepUncastLines: true })
    expect(plan!.nextTts.castAssignments?.["ep2-c10"]).toBe("")
    expect(plan!.report).toMatchObject({ newlyVoicedLines: 0, markedLines: 1 })
  })

  it("declines a project with nothing to fold", async () => {
    expect(await planProjectFold(db, { project_id: "small", project_name: null })).toBeNull()
    expect(await planProjectFold(db, { project_id: "no-tts", project_name: null })).toBeNull()
  })
})
