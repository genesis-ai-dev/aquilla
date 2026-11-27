// @vitest-environment node
//
// AQU-1941. Two halves: the write gate as a pure decision, and the SQL against
// real Postgres (PGlite) — the prefilter and the versioned write are exactly
// the parts a fixture test of the keep rules cannot reach. The `?` in the
// candidate pattern, for one, becomes a bind placeholder if it is inlined
// (db/shim/postgres.ts#toPg), and only a real query shows that.
import { PGlite } from "@electric-sql/pglite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadProjectSettings, patchProjectSettingsShared } from "../db/shared/projects"
import { TEST_PG_SESSION_SQL, testPgTemplate } from "../db/shared/test-pg-harness"
import { PostgresDb, type AquillaDb, type PgExecutor } from "../db/shim/postgres"
import type { ProjectTtsSettings, Voice } from "../src/lib/parsers/types"
import {
  decidePruneGate,
  listPruneCandidates,
  planProjectPrune,
  settingsBackupPath,
  PRODUCTION_FLAG,
} from "./phantom-voice-prune"

const base = { production: false, target: undefined, localUrl: undefined, applyCommand: "pnpm prune" }

describe("decidePruneGate", () => {
  it("never gates a dry run", () => {
    for (const target of [undefined, "dev", "local", "production"]) {
      expect(decidePruneGate({ ...base, apply: false, target }).kind, String(target)).toBe("proceed")
    }
  })

  it("refuses --production on a dry run, which writes nothing", () => {
    const decision = decidePruneGate({ ...base, apply: false, production: true, target: "production" })
    expect(decision.kind).toBe("refuse")
    expect(decision.kind === "refuse" && decision.message).toContain("without --apply")
  })

  it("refuses to apply to production without the flag, and prints the command", () => {
    const decision = decidePruneGate({ ...base, apply: true, target: "production" })
    expect(decision.kind).toBe("refuse")
    expect(decision.kind === "refuse" && decision.message).toContain(PRODUCTION_FLAG)
    expect(decision.kind === "refuse" && decision.message).toContain("pnpm prune -- --apply")
  })

  it("applies to production once it is named, and says a backup is coming", () => {
    const decision = decidePruneGate({ ...base, apply: true, production: true, target: "production" })
    expect(decision.kind).toBe("proceed")
    expect(decision.kind === "proceed" && decision.note).toContain("PRODUCTION")
  })

  it("applies to dev and local without ceremony", () => {
    expect(decidePruneGate({ ...base, apply: true, target: "dev" }).kind).toBe("proceed")
    expect(decidePruneGate({ ...base, apply: true, target: "local" }).kind).toBe("proceed")
    expect(decidePruneGate({ ...base, apply: true, localUrl: "postgresql://localhost/x" }).kind).toBe("proceed")
  })

  it("refuses a production flag that does not match the target", () => {
    for (const target of ["dev", "local"]) {
      const decision = decidePruneGate({ ...base, apply: true, production: true, target })
      expect(decision.kind, target).toBe("refuse")
      expect(decision.kind === "refuse" && decision.message).toContain(`Neon ${target}`)
    }
  })

  it("refuses to apply to an unidentified database", () => {
    const decision = decidePruneGate({ ...base, apply: true })
    expect(decision.kind).toBe("refuse")
    expect(decision.kind === "refuse" && decision.message).toContain("unidentified database")
  })

  // AQU-2658: the gate is shared (the cast fold, the cell-metadata repair), and
  // an operator refused a write must be told about THEIR write, not this one's.
  it("names the caller's own write in what it refuses and what it allows", () => {
    const repair = { ...base, action: "restore cell metadata", productionNote: "Nothing else is written." }
    const refused = decidePruneGate({ ...repair, apply: true, target: "production" })
    expect(refused.kind === "refuse" && refused.message).toContain("Refusing to restore cell metadata on Neon production")
    const unidentified = decidePruneGate({ ...repair, apply: true })
    expect(unidentified.kind === "refuse" && unidentified.message).toContain("Refusing to restore cell metadata on an unidentified database")
    const allowed = decidePruneGate({ ...repair, apply: true, production: true, target: "production" })
    expect(allowed.kind === "proceed" && allowed.note).toBe("⚠ applying to Neon PRODUCTION. Nothing else is written.")
    // Unnamed, it still speaks for the prune.
    const prune = decidePruneGate({ ...base, apply: true, target: "production" })
    expect(prune.kind === "refuse" && prune.message).toContain("Refusing to rewrite TTS settings on Neon production")
  })
})

describe("settingsBackupPath", () => {
  it("names the project and the version it restores", () => {
    const at = new Date("2026-10-14T01:23:45.678Z")
    expect(settingsBackupPath("/tmp/backups", "ac43a9f1", 3, at)).toBe(
      "/tmp/backups/ac43a9f1-v3-2026-10-14-01-23-45.json",
    )
  })

  it("tolerates a trailing slash and a path-shaped project id", () => {
    const at = new Date("2026-10-14T01:23:45.678Z")
    expect(settingsBackupPath("/tmp/backups/", "../etc/passwd", 1, at)).toBe(
      "/tmp/backups/.._etc_passwd-v1-2026-10-14-01-23-45.json",
    )
  })
})

// --- the SQL, against real Postgres -----------------------------------------

// The schema is db/postgres/schema.sql itself, loaded from the template every
// PGlite harness shares (db/shared/test-pg-harness.ts). This file used to carry
// its own copy of the four tables a settings write touches. A copy goes stale
// the moment a merged migration gives that write a new column or table to read:
// in October that happened three times, and the first left `dev` red for a day
// and failed 17 unit jobs on pull requests that had not touched this script.
const template = () => testPgTemplate(() => new PGlite())

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
const jesus: Voice = { id: "v-jesus", name: "JESUS", color: "#0e7490", provider: "inworld", voiceName: "Dennis" }

function phantoms(count: number): Voice[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `ph-${i}`,
    name: `MAT ${1 + Math.floor(i / 25)}:${(i % 25) + 1}`,
    color: "#475569",
  }))
}

let pg: PGlite
let db: AquillaDb

async function seedProject(id: string, name: string, tts: ProjectTtsSettings | undefined): Promise<void> {
  await pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, $2, 1)`, [id, name])
  await pg.query(`INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ($1, $2, 3, 1)`, [
    id,
    JSON.stringify(tts === undefined ? { validationCount: 2 } : { validationCount: 2, ttsSettings: tts }),
  ])
}

beforeEach(async () => {
  pg = new PGlite({
    loadDataDir: await template(),
    parsers: { 20: (v: string) => Number(v), 1700: (v: string) => Number(v) },
  })
  await pg.exec(TEST_PG_SESSION_SQL)
  db = new PostgresDb(pgliteExecutor(pg)) as unknown as AquillaDb

  const voicePhantoms = phantoms(200)
  const castAssignments: Record<string, string> = { "cell-jesus": jesus.id }
  voicePhantoms.forEach((v, i) => {
    castAssignments[`cell-ph-${i}`] = v.id
  })
  await seedProject("bloated", "Iloko — The Chosen", {
    defaultVoiceId: narrator.id,
    voices: [narrator, jesus, ...voicePhantoms],
    castAssignments,
  })
  await seedProject("clean", "Tagalog NT", {
    defaultVoiceId: narrator.id,
    voices: [narrator, jesus],
    castAssignments: { "cell-jesus": jesus.id },
  })
  // Every verse-named voice here is kept by a keep rule, so the prefilter hits
  // it and the plan must still decline to write.
  await seedProject("all-kept", "Kept by the rules", {
    defaultVoiceId: "ph-default",
    voices: [
      { id: "ph-default", name: "MAT 5:3", color: "#475569" },
      { id: "ph-character", name: "MAT 5:4", color: "#475569", libraryVoiceId: "narrator-hearth" },
    ],
  })
  await seedProject("no-tts", "Never opened the Studio", undefined)
})

afterEach(async () => {
  await pg.close()
})

async function version(projectId: string): Promise<number> {
  const row = await pg.query<{ version: number }>(`SELECT version FROM project_settings WHERE project_id = $1`, [
    projectId,
  ])
  return row.rows[0].version
}

describe("listPruneCandidates", () => {
  it("finds the projects with verse-named voices and no others", async () => {
    const ids = (await listPruneCandidates(db)).map((r) => r.project_id)
    expect(ids).toEqual(["all-kept", "bloated"])
  })

  it("carries the project name for the report", async () => {
    const [candidate] = await listPruneCandidates(db, { onlyProject: "bloated" })
    expect(candidate.project_name).toBe("Iloko — The Chosen")
  })

  it("scopes to --only and caps with --limit", async () => {
    expect((await listPruneCandidates(db, { onlyProject: "clean" })).length).toBe(0)
    expect((await listPruneCandidates(db, { limit: 1 })).map((r) => r.project_id)).toEqual(["all-kept"])
  })
})

describe("planProjectPrune", () => {
  it("reports the counts and bytes, and writes nothing", async () => {
    const [candidate] = await listPruneCandidates(db, { onlyProject: "bloated" })
    const plan = await planProjectPrune(db, candidate)

    expect(plan).not.toBeNull()
    const r = plan!.report
    expect(r.projectId).toBe("bloated")
    expect(r.projectName).toBe("Iloko — The Chosen")
    expect(r.totalVoices).toBe(202)
    expect(r.versePhantomVoices).toBe(200)
    expect(r.keptVoices).toBe(2)
    expect(r.assignmentsToDrop).toBe(200)
    expect(r.totalAssignments).toBe(201)
    expect(r.settingsBytesAfter).toBeLessThan(r.settingsBytesBefore)
    expect(r.versionBefore).toBe(3)
    expect(r.versionAfter).toBeNull()
    expect(r.applied).toBe(false)
    expect(await version("bloated")).toBe(3)
  })

  it("declines a project whose verse-named voices are all kept", async () => {
    const [candidate] = await listPruneCandidates(db, { onlyProject: "all-kept" })
    expect(await planProjectPrune(db, candidate)).toBeNull()
    expect(await version("all-kept")).toBe(3)
  })
})

describe("the versioned write", () => {
  it("prunes the stored blob and increments the version by exactly one", async () => {
    const [candidate] = await listPruneCandidates(db, { onlyProject: "bloated" })
    const plan = (await planProjectPrune(db, candidate))!

    const written = await patchProjectSettingsShared(db, {
      projectId: "bloated",
      ops: [{ key: "ttsSettings", value: plan.nextTts }],
      ifMatchVersion: plan.version,
      updatedBy: "0",
    })
    expect(written.status).toBe("ok")
    expect(await version("bloated")).toBe(4)

    const after = await loadProjectSettings(db, "bloated")
    const tts = after.settings.ttsSettings as ProjectTtsSettings
    expect(tts.voices?.map((v) => v.id)).toEqual(["preset-narrator", "v-jesus"])
    expect(tts.defaultVoiceId).toBe("preset-narrator")
    expect(tts.castAssignments).toEqual({ "cell-jesus": "v-jesus" })
    // Untouched neighbours in the same blob. (The write runs the whole blob
    // through `normalizeSettings`, as every settings write does — so this
    // pins that a neighbour survives it, not that it is byte-identical.)
    expect(after.settings.validationCount).toBe(2)

    // Idempotent: a second pass finds nothing to do.
    expect((await listPruneCandidates(db, { onlyProject: "bloated" })).length).toBe(0)
  })

  it("refuses the write when the version moved under it", async () => {
    const [candidate] = await listPruneCandidates(db, { onlyProject: "bloated" })
    const plan = (await planProjectPrune(db, candidate))!
    await pg.query(`UPDATE project_settings SET version = version + 1 WHERE project_id = 'bloated'`)

    const written = await patchProjectSettingsShared(db, {
      projectId: "bloated",
      ops: [{ key: "ttsSettings", value: plan.nextTts }],
      ifMatchVersion: plan.version,
      updatedBy: "0",
    })
    expect(written.status).toBe("conflict")
    expect(await version("bloated")).toBe(4)
  })
})
