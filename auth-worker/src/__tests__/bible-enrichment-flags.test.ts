// AQU-1686 — readBibleEnrichmentFlags: the server's view of a project's Bible
// data enrichments. Autopilot will read it per run; nothing calls it yet.
//
// WHY: the server must apply the same three rules the settings card shows. If
// Bible data is off, nothing is on. Otherwise an explicit choice wins, then the
// registry default. A project that switched an enrichment off must never have
// it used on the server, and the read must come from the generated columns
// (migration 0141), not from the multi-MB settings blob.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { readBibleEnrichmentFlags } from "../lib/aquifer/gate"
import { BIBLE_ENRICHMENTS, BIBLE_ENRICHMENT_IDS } from "../../../db/shared/bible-enrichments"
import { seedUser } from "./helpers/db"

let counter = 0
async function seedProject(opts: { scripture: boolean; settings?: Record<string, unknown> }): Promise<string> {
  counter += 1
  const id = `22222222-2222-4222-8${String(counter).padStart(3, "0")}-222222222222`
  await seedUser(1, `owner_${id}`)
  await env.AQUILLA_PG.prepare(`INSERT INTO projects (id, name, created_by) VALUES (?, 'P', 1)`).bind(id).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, kind, event_id, cell_count, approved_count, word_count, last_edit_at)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, NULL)`,
  )
    .bind(`f-${id}`, id, "f", opts.scripture ? "usfm" : "docx", `evt-${id}`)
    .run()
  if (opts.settings) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (?, ?, 1, 1)`,
    )
      .bind(id, JSON.stringify(opts.settings))
      .run()
  }
  return id
}

const defaults = () => Object.fromEntries(BIBLE_ENRICHMENT_IDS.map((id) => [id, BIBLE_ENRICHMENTS[id].default]))
const allOff = () => Object.fromEntries(BIBLE_ENRICHMENT_IDS.map((id) => [id, false]))

describe("readBibleEnrichmentFlags", () => {
  it("turns every enrichment off when Bible data is explicitly off, whatever each one says", async () => {
    const p = await seedProject({
      scripture: true,
      settings: { bibleResourcesEnabled: false, bibleEnrichments: { voices: true, autopilot: true } },
    })
    expect(await readBibleEnrichmentFlags(env, p)).toEqual(allOff())
  })

  it("uses the registry defaults when nothing is set on a scripture project", async () => {
    const p = await seedProject({ scripture: true })
    const flags = await readBibleEnrichmentFlags(env, p)
    expect(flags).toEqual(defaults())
    // Autopilot stays off until a maintainer turns it on.
    expect(flags.autopilot).toBe(false)
  })

  it("turns everything off when nothing is set and the project has no scripture files", async () => {
    const p = await seedProject({ scripture: false })
    expect(await readBibleEnrichmentFlags(env, p)).toEqual(allOff())
  })

  it("lets an explicit choice win over the default, in both directions", async () => {
    const p = await seedProject({
      scripture: false,
      settings: { bibleResourcesEnabled: true, bibleEnrichments: { places: false, autopilot: true } },
    })
    expect(await readBibleEnrichmentFlags(env, p)).toEqual({ ...defaults(), places: false, autopilot: true })
  })

  // A hand-edited blob must not switch anything on: only known ids with
  // boolean values count.
  it("ignores unknown ids and values that are not booleans", async () => {
    const p = await seedProject({
      scripture: true,
      settings: { bibleEnrichments: { autopilot: "yes", nope: true, voices: false } },
    })
    expect(await readBibleEnrichmentFlags(env, p)).toEqual({ ...defaults(), voices: false })
  })

  it("reads the generated columns, never the settings blob", async () => {
    const p = await seedProject({
      scripture: true,
      settings: { bibleResourcesEnabled: true, bibleEnrichments: { voices: false } },
    })
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
    } as unknown as typeof env

    expect((await readBibleEnrichmentFlags(recording, p)).voices).toBe(false)
    const settingsReads = statements.filter((sql) => /\bproject_settings\b/.test(sql))
    expect(settingsReads).toHaveLength(1)
    expect(settingsReads[0]).toMatch(/\bbible_enrichments\b/)
    expect(settingsReads[0]).not.toMatch(/\bsettings\b/)
    // The switch is explicit, so the files table is not consulted.
    expect(statements.some((sql) => /\bfiles\b/.test(sql))).toBe(false)
  })
})
