// AQU-460 — the Bible Aquifer gate's derive-on-read logic.
//
// WHY: the prior design persisted `bibleResourcesEnabled` via a client
// load-time effect, which silently re-enabled an explicit OFF (a trust bug).
// The redesign never writes anything — `isBibleResourcesEnabled` DERIVES the
// effective value at read time: explicit override wins when set; otherwise
// scripture-file presence decides. These tests exercise the full matrix
// directly against `isBibleResourcesEnabled`, independent of the HTTP layer
// (aquifer-routes.test.ts covers the route-level 404/200 behavior).

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { isBibleResourcesEnabled } from "../lib/aquifer/gate"
import { seedUser } from "./helpers/db"

async function seedProject(id: string): Promise<void> {
  await seedUser(1, `owner_${id}`)
  await env.AQUILLA_PG.prepare(`INSERT INTO projects (id, name, created_by) VALUES (?, 'P', 1)`)
    .bind(id)
    .run()
}

async function seedFile(projectId: string, fileId: string, kind: string | null): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, kind, event_id, cell_count, approved_count, word_count, last_edit_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, NULL)`,
  )
    .bind(fileId, projectId, fileId, kind, `evt-${fileId}`)
    .run()
}

async function markScriptureContent(fileId: string): Promise<void> {
  await env.AQUILLA_PG.prepare(`UPDATE files SET meta = ? WHERE id = ?`)
    .bind(JSON.stringify({ aquillaImport: { hasScriptureContent: true } }), fileId)
    .run()
}

async function seedExplicitSetting(projectId: string, value: boolean): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (?, ?, 1, 1)`,
  )
    .bind(projectId, JSON.stringify({ bibleResourcesEnabled: value }))
    .run()
}

let counter = 0
function freshProjectId(): string {
  counter += 1
  return `11111111-1111-4111-8${String(counter).padStart(3, "0")}-111111111111`
}

describe("isBibleResourcesEnabled — AQU-460 derive-on-read matrix", () => {
  it("unset + scripture file (usfm) -> true (derived default-on)", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "usfm")
    expect(await isBibleResourcesEnabled(env, p)).toBe(true)
  })

  it("unset + scripture file (ebible) -> true", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "ebible")
    expect(await isBibleResourcesEnabled(env, p)).toBe(true)
  })

  it("unset + scripture file (helloao) -> true", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "helloao")
    expect(await isBibleResourcesEnabled(env, p)).toBe(true)
  })

  it("unset + non-scripture file only -> false", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "docx")
    expect(await isBibleResourcesEnabled(env, p)).toBe(false)
  })

  it("unset + Scripture-shaped spreadsheet -> true without changing its file kind", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "xlsx")
    await markScriptureContent("f1")
    expect(await isBibleResourcesEnabled(env, p)).toBe(true)
  })

  it("unset + no files at all -> false", async () => {
    const p = freshProjectId()
    await seedProject(p)
    expect(await isBibleResourcesEnabled(env, p)).toBe(false)
  })

  it("explicit true, no scripture files -> true (explicit override wins)", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "docx")
    await seedExplicitSetting(p, true)
    expect(await isBibleResourcesEnabled(env, p)).toBe(true)
  })

  it("explicit false, HAS scripture files -> false (the trust invariant: explicit OFF always respected)", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "usfm")
    await seedExplicitSetting(p, false)
    expect(await isBibleResourcesEnabled(env, p)).toBe(false)
  })

  it("scripture file that is soft-deleted (deleted_at set) does not count toward derivation", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "usfm")
    await env.AQUILLA_PG.prepare(`UPDATE files SET deleted_at = 1 WHERE id = 'f1'`).run()
    expect(await isBibleResourcesEnabled(env, p)).toBe(false)
  })

  // Moving the read to a generated column (0150) must not change what counts
  // as an explicit choice: the gate always read the `->>` text, so a stored
  // string "false" is still an explicit OFF that beats the scripture default.
  it("a stored string 'false' is still an explicit OFF", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "usfm")
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (?, ?, 1, 1)`,
    )
      .bind(p, JSON.stringify({ bibleResourcesEnabled: "false" }))
      .run()
    expect(await isBibleResourcesEnabled(env, p)).toBe(false)
  })
})

// AQU-1686: the settings blob runs to several MB, and the project_settings
// schema comment forbids parsing it inline on a read path. The gate runs on
// every aquifer route and agent run, so it must answer from the generated
// column (migration 0150) — while keeping the derive-on-read matrix above.
describe("isBibleResourcesEnabled — reads the generated column", () => {
  function recordingEnv(): { env: typeof env; statements: string[] } {
    const statements: string[] = []
    const db = env.AQUILLA_PG
    const recording = {
      ...env,
      AQUILLA_PG: {
        prepare: (sql: string) => {
          statements.push(sql)
          return db.prepare(sql)
        },
      },
    }
    return { env: recording as unknown as typeof env, statements }
  }

  it("selects bible_resources_enabled and never the settings blob", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "usfm")
    await seedExplicitSetting(p, false)
    const recorded = recordingEnv()

    expect(await isBibleResourcesEnabled(recorded.env, p)).toBe(false)

    const settingsReads = recorded.statements.filter((sql) => /\bproject_settings\b/.test(sql))
    expect(settingsReads).toHaveLength(1)
    expect(settingsReads[0]).toMatch(/\bbible_resources_enabled\b/)
    // `\bsettings\b` matches the blob column, not `project_settings`.
    expect(settingsReads[0]).not.toMatch(/\bsettings\b/)
    // An explicit value answers on its own: no files query.
    expect(recorded.statements.some((sql) => /\bfiles\b/.test(sql))).toBe(false)
  })

  it("still derives from scripture files when the column is NULL", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "usfm")
    // A settings row without the key: the generated column is NULL.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (?, ?, 1, 1)`,
    )
      .bind(p, JSON.stringify({ targetLanguage: "fr" }))
      .run()
    const recorded = recordingEnv()

    expect(await isBibleResourcesEnabled(recorded.env, p)).toBe(true)
    expect(recorded.statements.some((sql) => /\bfiles\b/.test(sql))).toBe(true)
  })
})

/** The live database, except that the 0150 columns do not exist: any statement
 *  that names them fails the way Postgres does (undefined_column, 42703). */
function envWithout0150(): { env: typeof env; statements: string[] } {
  const statements: string[] = []
  const db = env.AQUILLA_PG
  const missing = Object.assign(new Error('column "bible_resources_enabled" does not exist'), { code: "42703" })
  const failing = {
    bind: () => failing,
    first: async () => { throw missing },
    all: async () => { throw missing },
    run: async () => { throw missing },
  }
  const without = {
    ...env,
    AQUILLA_PG: {
      prepare: (sql: string) => {
        statements.push(sql)
        return /\bbible_resources_enabled\b|\bbible_enrichments\b/.test(sql) ? failing : db.prepare(sql)
      },
    },
  }
  return { env: without as unknown as typeof env, statements }
}

// The QA bot's finding on this PR: with 0150 not applied, the column read
// failed, the gate took that as "no choice", and a scripture project that had
// switched Bible data OFF was let through. The gate now reads the blob instead.
describe("isBibleResourcesEnabled — on a database without migration 0150", () => {
  it("keeps an explicit OFF off on a scripture project", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "usfm")
    await seedExplicitSetting(p, false)
    const without = envWithout0150()

    expect(await isBibleResourcesEnabled(without.env, p)).toBe(false)
    // It fell back to the blob, as the gate read it before AQU-1686.
    expect(without.statements.some((sql) => /settings::jsonb ->> 'bibleResourcesEnabled'/.test(sql))).toBe(true)
  })

  it("keeps an explicit ON on, with no scripture files", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "docx")
    await seedExplicitSetting(p, true)
    expect(await isBibleResourcesEnabled(envWithout0150().env, p)).toBe(true)
  })

  it("still derives from scripture files when nothing is set: on with scripture", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "usfm")
    expect(await isBibleResourcesEnabled(envWithout0150().env, p)).toBe(true)
  })

  it("still derives from scripture files when nothing is set: off without", async () => {
    const p = freshProjectId()
    await seedProject(p)
    await seedFile(p, "f1", "docx")
    expect(await isBibleResourcesEnabled(envWithout0150().env, p)).toBe(false)
  })
})
