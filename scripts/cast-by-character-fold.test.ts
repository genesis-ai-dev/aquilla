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
import { assignedCastVoiceId, characterCastKey } from "../src/lib/audio/voices"
import type { ProjectTtsSettings, Voice } from "../src/lib/parsers/types"
import { listFoldCandidates, loadCastLines, planLineNames, planProjectFold, writeLineNames } from "./cast-by-character-fold"

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
    records_audio BOOLEAN NOT NULL DEFAULT false,
    -- 0187: what the language delivers (media redesign slice 1).
    delivers TEXT CHECK (delivers IS NULL OR delivers IN ('text', 'audio', 'text_and_audio'))
  );
  CREATE TABLE org_settings (
    org_id   BIGINT PRIMARY KEY,
    settings TEXT NOT NULL DEFAULT '{}',
    validation_count TEXT GENERATED ALWAYS AS ((settings::jsonb)->>'validationCount') STORED,
    validation_count_audio TEXT GENERATED ALWAYS AS ((settings::jsonb)->>'validationCountAudio') STORED
  );
  CREATE TABLE cells (
    project_id TEXT NOT NULL, file_id TEXT NOT NULL, cell_id TEXT NOT NULL,
    side TEXT NOT NULL, metadata JSONB, sequence_index DOUBLE PRECISION, tombstoned_at TIMESTAMPTZ,
    camera_state TEXT,
    PRIMARY KEY (project_id, file_id, cell_id, side)
  );
  CREATE TABLE events (
    id TEXT PRIMARY KEY, schema_version INTEGER, project_id TEXT, file_id TEXT, cell_id TEXT,
    kind TEXT, author TEXT, payload TEXT, client_ts BIGINT, server_ts BIGINT, parent_id TEXT,
    server_seq BIGINT, provenance JSONB
  );
  CREATE TABLE project_seq_counters (project_id TEXT PRIMARY KEY, last_seq BIGINT NOT NULL);
  CREATE TABLE seq_allocations (
    project_id TEXT NOT NULL, first_seq BIGINT NOT NULL, last_seq BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

describe("--name-lines: projects cast before imports wrote the speaker (AQU-2125 follow-up)", () => {
  // "tagged": cast from a subtitle file's speaker tags — one entry per line, no
  // character on any line. Two episodes, three speakers, one line recast by
  // hand to the built-in Narrator, one line deleted, one already named.
  const mary: Voice = { id: "v-mary", name: "MARY", color: "#7c3aed" }
  const idNamed: Voice = { id: "v-x", name: "a89dec11-d60e-48c1-9f3a-2b5f0c1d7e44", color: "#000" }
  async function seedTagged(): Promise<Record<string, string>> {
    const cast: Record<string, string> = {}
    const who = [jesus, peter, mary]
    for (const ep of ["t1", "t2"]) {
      for (let i = 0; i < 120; i++) {
        const id = `${ep}-l${i}`
        await seedCell("tagged", ep, id, "source", null, i)
        cast[id] = who[i % 3].id
      }
    }
    cast["t1-l5"] = narrator.id
    cast["t1-l7"] = idNamed.id
    await pg.query(`UPDATE cells SET tombstoned_at = now() WHERE cell_id = 't2-l9'`)
    await pg.query(`UPDATE cells SET metadata = '{"cast_name":"PETER"}' WHERE cell_id = 't2-l1'`)
    await seedProject("tagged", "Come and See — speaker tags", {
      voices: [narrator, jesus, peter, mary, idNamed],
      defaultVoiceId: narrator.id,
      castAssignments: cast,
    })
    return cast
  }

  it("names each line with its voice's name, and nothing that is not a person's name", async () => {
    await seedTagged()
    const loaded = await loadProjectSettings(db, "tagged")
    const { results } = await db
      .prepare(`SELECT cell_id, file_id, metadata ->> 'cast_name' AS cast_name, (tombstoned_at IS NOT NULL) AS gone FROM cells WHERE project_id = ? ORDER BY file_id, sequence_index`)
      .bind("tagged")
      .all<{ cell_id: string; file_id: string; cast_name: string | null; gone: boolean }>()
    const names = planLineNames(loaded.settings.ttsSettings as ProjectTtsSettings, results)
    const byId = new Map(names.map((n) => [n.cellId, n.castName]))
    expect(byId.get("t1-l0")).toBe("JESUS")
    expect(byId.get("t1-l1")).toBe("PETER")
    expect(byId.get("t1-l2")).toBe("MARY")
    expect(byId.has("t1-l5")).toBe(false) // the built-in Narrator
    expect(byId.has("t1-l7")).toBe(false) // a voice named by its id
    expect(byId.has("t2-l9")).toBe(false) // deleted
    expect(byId.has("t2-l1")).toBe(false) // already named
    expect(names).toHaveLength(240 - 4)
  })

  it("leaves a project alone whose voices are one per line, not a cast", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ cell_id: `c${i}`, file_id: "f", cast_name: null, gone: false }))
    const voices = rows.map((_, i) => ({ id: `v${i}`, name: `Person ${String.fromCharCode(65 + i)}`, color: "#000" }))
    const castAssignments = Object.fromEntries(rows.map((r, i) => [r.cell_id, `v${i}`]))
    expect(planLineNames({ voices, castAssignments }, rows)).toEqual([])
  })

  it("plans the names and the fold together, and every line keeps its voice", async () => {
    const cast = await seedTagged()
    // Without naming, only the one line that already names PETER can fold.
    const plain = await planProjectFold(db, { project_id: "tagged", project_name: null })
    expect(plain!.report).toMatchObject({ linesToName: 0, entriesBefore: 240, entriesAfter: 240 })
    const plan = await planProjectFold(db, { project_id: "tagged", project_name: null }, { nameLines: true })
    expect(plan!.report).toMatchObject({ linesToName: 236, entriesBefore: 240 })
    expect(plan!.report.entriesAfter).toBeLessThanOrEqual(7)
    const before = { voices: [narrator, jesus, peter, mary, idNamed], castAssignments: cast }
    const after = { voices: before.voices, castAssignments: plan!.nextTts.castAssignments }
    const nameOf = new Map(plan!.names.map((n) => [n.cellId, n.castName]))
    for (const id of Object.keys(cast)) {
      const castName = id === "t2-l1" ? "PETER" : nameOf.get(id) ?? null
      expect(assignedCastVoiceId(after, { id, castName })).toBe(assignedCastVoiceId(before, id))
    }
  })

  it("writes each name as a cast.assign event with a server_seq, onto the source row, once", async () => {
    await seedTagged()
    const plan = await planProjectFold(db, { project_id: "tagged", project_name: null }, { nameLines: true })
    const written = await writeLineNames(db, "tagged", plan!.names, "maintenance")
    expect(written).toBe(236)
    const events = await pg.query<{ kind: string; author: string; payload: string; server_seq: number; cell_id: string }>(
      `SELECT kind, author, payload, server_seq, cell_id FROM events ORDER BY server_seq`,
    )
    expect(events.rows).toHaveLength(236)
    expect(new Set(events.rows.map((e) => e.kind))).toEqual(new Set(["cast.assign"]))
    expect(events.rows[0]).toMatchObject({ author: "maintenance", payload: JSON.stringify({ castName: "JESUS" }) })
    expect(events.rows.map((e) => Number(e.server_seq))).toEqual(events.rows.map((_, i) => i + 1))
    const named = await pg.query<{ cast_name: string }>(`SELECT metadata ->> 'cast_name' AS cast_name FROM cells WHERE cell_id = 't1-l2'`)
    expect(named.rows[0].cast_name).toBe("MARY")
    expect((await pg.query(`SELECT * FROM seq_allocations`)).rows).toHaveLength(0)
    // A re-run writes no second copy, and the fold now needs no naming.
    await writeLineNames(db, "tagged", plan!.names, "maintenance")
    expect((await pg.query(`SELECT count(*)::int AS n FROM events`)).rows[0]).toEqual({ n: 236 })
    const again = await planProjectFold(db, { project_id: "tagged", project_name: null }, { nameLines: true })
    expect(again!.report.linesToName).toBe(0)
  })
})
