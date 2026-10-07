import { env } from "cloudflare:test"
import { describe, it, expect, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { getOrgPortfolios } from "../services/org-permissions"
import type { Env } from "../types"

describe("GET /api/v2/orgs/:orgId/portfolio", () => {
  it("returns per-project rollup (validated cells + last activity) for org projects", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1), ('pb', 'Mark', 1, 1)").run()
    // events required as FK target for files.event_id (Postgres enforces FKs)
    // server_seq must be distinct per project due to UNIQUE INDEX idx_events_project_seq
    await env.AQUILLA_PG.prepare("INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e1', 1, 'pa', 'file.create', 'wendi', '{}', 1000, 1000, 1), ('e2', 1, 'pa', 'file.create', 'wendi', '{}', 2000, 2000, 2), ('e3', 1, 'pb', 'file.create', 'wendi', '{}', 500, 500, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO files (id, project_id, name, event_id, cell_count, approved_count, last_edit_at) VALUES ('f1', 'pa', 'GEN', 'e1', 100, 40, 1000), ('f2', 'pa', 'EXO', 'e2', 100, 10, 2000), ('f3', 'pb', 'MRK', 'e3', 50, 50, 500)").run()

    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string; name: string; totalCells: number; validatedCells: number; lastEditAt: number | null }> }
    const byId = Object.fromEntries(body.projects.map((p) => [p.id, p]))
    expect(byId.pa).toMatchObject({ totalCells: 200, validatedCells: 50, lastEditAt: 2000 })
    expect(byId.pb).toMatchObject({ totalCells: 50, validatedCells: 50, lastEditAt: 500 })
  })

  it("excludes archived projects and 403s a non-org-member", async () => {
    await seedUser(1, "wendi"); await seedUser(9, "outsider")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by, archived_at) VALUES ('pz', 'Old', 1, 1, '2026-01-01')").run()
    const ok = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(((await ok.json()) as { projects: unknown[] }).projects).toHaveLength(0)
    const denied = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("outsider")) }, env)
    expect(denied.status).toBe(403)
  })

  it("includes per-project audio progress (cells with a selected dub + its recorded ms)", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1), ('pb', 'Mark', 1, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e1', 1, 'pa', 'file.create', 'wendi', '{}', 1000, 1000, 1), ('e3', 1, 'pb', 'file.create', 'wendi', '{}', 500, 500, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO files (id, project_id, name, event_id, cell_count, approved_count, last_edit_at) VALUES ('f1', 'pa', 'GEN', 'e1', 100, 40, 1000), ('f3', 'pb', 'MRK', 'e3', 50, 50, 500)").run()
    // pa: c1+c2 selected recordings (90000ms); c3 unselected; c4 deleted.
    //
    // AQU-490 narrowed "has audio" from any live take to a SELECTED dub take,
    // so c3 no longer counts. The word that does the work in practice is
    // "dub", not "selected" — attaching selects, so an unselected-only cell is
    // vanishingly rare — but the two must name the same set as the histogram
    // the board reads, or a cell could sit in the denominator and never reach
    // the numerator and audio could never read 100%.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cell_audio (project_id, file_id, cell_id, audio_id, slot, url, duration_ms, selected, deleted, event_id, created_ts) VALUES
        ('pa','f1','c1','a1','recording','frontier-audio://a1.wav',60000,1,0,'ae1',1),
        ('pa','f1','c2','a2','recording','frontier-audio://a2.wav',30000,1,0,'ae2',1),
        ('pa','f1','c3','a3','recording','frontier-audio://a3.wav',99999,0,0,'ae3',1),
        ('pa','f1','c4','a4','recording','frontier-audio://a4.wav',99999,1,1,'ae4',1)`,
    ).run()

    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string; audioCells: number; recordedMs: number }> }
    const byId = Object.fromEntries(body.projects.map((p) => [p.id, p]))
    expect(byId.pa).toMatchObject({ audioCells: 2, recordedMs: 90000 })
    expect(byId.pb).toMatchObject({ audioCells: 0, recordedMs: 0 })
  })

  it("AQU-523: surfaces the source/target language pair from project_settings, null when unset", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    // pa: languages set in project_settings; pb: no settings row; pc: settings
    // row present but with no language keys (the empty-defaults case).
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1), ('pb', 'Mark', 1, 1), ('pc', 'Luke', 1, 1)").run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_settings (project_id, settings, version) VALUES
        ('pa', '{"sourceLanguage":"Greek","targetLanguage":"Bambara"}', 1),
        ('pc', '{}', 1)`,
    ).run()
    // A file per project keeps the LEFT JOIN row-multiplication realistic — the
    // MAX() over the 1:1 settings join must still collapse to one value.
    await env.AQUILLA_PG.prepare("INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e1', 1, 'pa', 'file.create', 'wendi', '{}', 1000, 1000, 1), ('e2', 1, 'pa', 'file.create', 'wendi', '{}', 2000, 2000, 2), ('e3', 1, 'pb', 'file.create', 'wendi', '{}', 500, 500, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO files (id, project_id, name, event_id, cell_count, approved_count, last_edit_at) VALUES ('f1', 'pa', 'GEN', 'e1', 100, 40, 1000), ('f2', 'pa', 'EXO', 'e2', 100, 10, 2000), ('f3', 'pb', 'MRK', 'e3', 50, 50, 500)").run()

    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string; sourceLanguage: string | null; targetLanguage: string | null; totalCells: number }> }
    const byId = Object.fromEntries(body.projects.map((p) => [p.id, p]))
    expect(byId.pa).toMatchObject({ sourceLanguage: "Greek", targetLanguage: "Bambara", totalCells: 200 })
    expect(byId.pb).toMatchObject({ sourceLanguage: null, targetLanguage: null })
    expect(byId.pc).toMatchObject({ sourceLanguage: null, targetLanguage: null })
  })

  it("AQU-538: per-lane aggregates from file_section_progress file-scope rows (default '' row always present)", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e1', 1, 'pa', 'file.create', 'wendi', '{}', 1000, 1000, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO files (id, project_id, name, event_id, cell_count, approved_count, last_edit_at) VALUES ('f1', 'pa', 'GEN', 'e1', 45, 5, 2000)").run()
    // Project validationCount = 2: a cell is "validated" only at >= 2 endorsements.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings) VALUES ('pa', ?)",
    ).bind(JSON.stringify({ validationCount: 2 })).run()
    // Two lanes of the same file. total_count is lane-independent (source rows).
    // '' lane: filled 15, histogram {0:30,1:10,2:5} → validated(>=2) = 5, updated 1500.
    // es lane: filled 2,  histogram {0:43,3:2}      → validated(>=2) = 2, updated 2600.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO file_section_progress (project_id, file_id, scope, section_key, target_lang, total_count, filled_count, validator_histogram, revision, updated_at) VALUES
        ('pa','f1','file','', '',   45, 15, ?, 1, 1500),
        ('pa','f1','file','', 'es', 45, 2,  ?, 1, 2600)`,
    ).bind(JSON.stringify({ "0": 30, "1": 10, "2": 5 }), JSON.stringify({ "0": 43, "3": 2 })).run()

    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string; lanes: Array<{ lane: string; totalCells: number; filledCells: number; validatedCells: number; lastEditAt: number | null }> }> }
    const pa = body.projects.find((p) => p.id === "pa")!
    // Default lane first, then by tag.
    expect(pa.lanes.map((l) => l.lane)).toEqual(["", "es"])
    const byLane = Object.fromEntries(pa.lanes.map((l) => [l.lane, l]))
    expect(byLane[""]).toMatchObject({ totalCells: 45, filledCells: 15, validatedCells: 5, lastEditAt: 1500 })
    expect(byLane.es).toMatchObject({ totalCells: 45, filledCells: 2, validatedCells: 2, lastEditAt: 2600 })
    // Scalar fields remain cross-lane (from files), untouched by the lane rollup.
    const paScalar = body.projects.find((p) => p.id === "pa") as unknown as { totalCells: number; validatedCells: number }
    expect(paScalar).toMatchObject({ totalCells: 45, validatedCells: 5 })
  })

  it("AQU-538: a REGISTERED lane with no progress rows yet appears as a 0% row (PM sees the chip immediately)", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)").run()
    // Lane registry carries 'swh' — no translations committed on it yet.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings) VALUES ('pa', ?)",
    ).bind(JSON.stringify({ targetLanes: ["swh"] })).run()
    // Only the default lane has progress rows.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO file_section_progress (project_id, file_id, scope, section_key, target_lang, total_count, filled_count, validator_histogram, revision, updated_at) VALUES
        ('pa','f1','file','', '', 45, 15, ?, 1, 1500)`,
    ).bind(JSON.stringify({ "0": 30, "1": 15 })).run()

    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string; lanes: Array<{ lane: string; totalCells: number; filledCells: number; validatedCells: number; lastEditAt: number | null }> }> }
    const pa = body.projects.find((p) => p.id === "pa")!
    expect(pa.lanes.map((l) => l.lane)).toEqual(["", "swh"])
    const swh = pa.lanes.find((l) => l.lane === "swh")!
    // Denominator borrowed from the '' row; nothing translated or validated yet.
    expect(swh).toMatchObject({ totalCells: 45, filledCells: 0, validatedCells: 0, lastEditAt: null })
  })

  it("AQU-538: N=1 project surfaces a single '' lane row", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e1', 1, 'pa', 'file.create', 'wendi', '{}', 1000, 1000, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO files (id, project_id, name, event_id, cell_count, approved_count, last_edit_at) VALUES ('f1', 'pa', 'GEN', 'e1', 10, 3, 1000)").run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO file_section_progress (project_id, file_id, scope, section_key, target_lang, total_count, filled_count, validator_histogram, revision, updated_at) VALUES
        ('pa','f1','file','', '', 10, 4, ?, 1, 1200)`,
    ).bind(JSON.stringify({ "0": 6, "1": 4 })).run()

    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string; lanes: Array<{ lane: string; totalCells: number; filledCells: number; validatedCells: number }> }> }
    const pa = body.projects.find((p) => p.id === "pa")!
    expect(pa.lanes).toHaveLength(1)
    // Default validationCount = 1 (no settings row) → validated = buckets >= 1 = 4.
    expect(pa.lanes[0]).toMatchObject({ lane: "", totalCells: 10, filledCells: 4, validatedCells: 4 })
  })

  it("AQU-1458: an archived lane row is flagged, and a settings-only archive is too", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1), ('pb', 'Acts', 1, 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings) VALUES ('pb', ?)",
    ).bind(JSON.stringify({ targetLanguage: "English", targetLanes: ["sw"], archivedLanes: ["sw"] })).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO lanes (id, project_id, role, name, legacy_tag, position, archived_at) VALUES
        ('deflane1', 'pa', 'target', 'Spanish', '', 0, NULL),
        ('swlane01', 'pa', 'target', 'Swahili', 'sw', 1, '2026-09-01T00:00:00Z'),
        ('frlane01', 'pa', 'target', 'French', 'fr', 2, NULL),
        ('deflane2', 'pb', 'target', 'English', '', 0, NULL),
        ('swlane02', 'pb', 'target', 'Swahili', 'sw', 1, NULL)`,
    ).run()

    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string; lanes: Array<{ lane: string; archived?: boolean }> }> }
    const pa = body.projects.find((p) => p.id === "pa")!
    const byLane = Object.fromEntries(pa.lanes.map((l) => [l.lane, l]))
    expect(pa.lanes.map((l) => l.lane)).toEqual(["", "sw", "fr"])
    expect(byLane[""].archived).toBeUndefined()
    expect(byLane.sw.archived).toBe(true)
    expect(byLane.fr.archived).toBeUndefined()
    const pb = body.projects.find((p) => p.id === "pb")!
    expect(pb.lanes.find((l) => l.lane === "sw")?.archived).toBe(true)
    expect(pb.lanes.find((l) => l.lane === "")?.archived).toBeUndefined()
  })

  // The settings-only archive is read from project_settings.archived_lanes, a
  // STORED generated column (migration 0139), instead of by parsing the blob
  // per project. A generated column cannot drift from the JSON, and these hold
  // it to that: what the dashboard shows must follow each settings write.
  it("AQU-1458: a settings-only archive follows the settings as they change", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'Acts', 1, 1), ('pb', 'Bare', 1, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO lanes (id, project_id, role, name, legacy_tag, position) VALUES
        ('deflane1', 'pa', 'target', 'English', '', 0),
        ('swlane01', 'pa', 'target', 'Swahili', 'sw', 1),
        ('frlane01', 'pa', 'target', 'French', 'fr', 2),
        ('deflane2', 'pb', 'target', 'English', '', 0),
        ('swlane02', 'pb', 'target', 'Swahili', 'sw', 1)`,
    ).run()
    const saveSettings = (settings: unknown) =>
      env.AQUILLA_PG.prepare(
        `INSERT INTO project_settings (project_id, settings) VALUES ('pa', ?)
         ON CONFLICT (project_id) DO UPDATE SET settings = EXCLUDED.settings, version = project_settings.version + 1`,
      ).bind(JSON.stringify(settings)).run()
    const archived = async (projectId = "pa") => {
      const rows = await getOrgPortfolios(env as unknown as Env, [1], { userId: 1, isAdmin: false })
      const project = rows.find((row) => row.id === projectId)!
      return project.lanes.filter((lane) => lane.archived).map((lane) => lane.lane)
    }

    // No settings row at all: nothing is archived, and nothing breaks.
    expect(await archived()).toEqual([])
    expect(await archived("pb")).toEqual([])

    await saveSettings({ targetLanguage: "English", targetLanes: ["sw", "fr"], archivedLanes: ["sw"] })
    expect(await archived()).toEqual(["sw"])
    // Only the project that recorded it. The sibling has the same lane tag.
    expect(await archived("pb")).toEqual([])

    // Tags are matched without regard to case, as before.
    await saveSettings({ targetLanguage: "English", targetLanes: ["sw", "fr"], archivedLanes: ["SW", "fr"] })
    expect(await archived()).toEqual(["sw", "fr"])

    // Restoring a lane is a settings write too, and the flag goes with it.
    await saveSettings({ targetLanguage: "English", targetLanes: ["sw", "fr"], archivedLanes: [] })
    expect(await archived()).toEqual([])

    // The key is hand-editable JSON. Anything that is not a list of tags
    // archives nothing rather than failing the whole dashboard.
    for (const malformed of ["sw", { sw: true }, 7, null, [7, null, ""]]) {
      await saveSettings({ targetLanguage: "English", targetLanes: ["sw", "fr"], archivedLanes: malformed })
      expect(await archived()).toEqual([])
    }
    await saveSettings({ targetLanguage: "English", targetLanes: ["sw", "fr"] })
    expect(await archived()).toEqual([])
  })

  // 2026-10-05: with the rollup beside it fixed, parsing each project's blob
  // for this one key was most of the all-organizations dashboard's time (4s
  // warm, 10s cold, for 433 projects). Blobs run to several MB. No statement
  // on this page may fetch one, whoever is asking.
  it.each([
    ["an org owner", 1, false],
    ["a member behind the lane read wall", 2, false],
    ["a platform admin", 1, true],
  ] as const)("never reads a project's settings blob for %s", async (_who, userId, isAdmin) => {
    await seedUser(1, "wendi")
    await seedUser(2, "translator")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1)",
    ).run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'Acts', 1, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO project_members (project_id, user_id, role_level) VALUES ('pa', 2, 400)").run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_settings (project_id, settings) VALUES ('pa', '{"targetLanes":["sw"],"archivedLanes":["sw"]}')`,
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO lanes (id, project_id, role, name, legacy_tag, position) VALUES ('swlane01', 'pa', 'target', 'Swahili', 'sw', 1)",
    ).run()

    const statements: string[] = []
    const db = {
      prepare(query: string) {
        statements.push(query)
        return env.AQUILLA_PG.prepare(query)
      },
    }
    const rows = await getOrgPortfolios(
      { ...env, AQUILLA_PG: db, LANE_READ_WALL: "1" } as unknown as Env,
      [1],
      { userId, isAdmin },
    )

    expect(rows.map((row) => row.id)).toEqual(["pa"])
    expect(statements.length).toBeGreaterThan(3)
    const readsBlob = statements.filter((query) => /\bsettings\s*::\s*jsonb|\b(ps|os|project_settings|org_settings)\.settings\b/.test(query))
    expect(readsBlob).toEqual([])
  })

  it("AQU-1473: the primary language stored in targetLanes is the default lane, not a second one", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)").run()
    // Create writes the primary into both targetLanguage and the complete registry.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings) VALUES ('pa', ?)",
    ).bind(JSON.stringify({ targetLanguage: "Spanish", targetLanes: ["Spanish", "French"] })).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO lanes (id, project_id, role, name, legacy_tag) VALUES ('deflane1', 'pa', 'target', 'Spanish', '')",
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO file_section_progress (project_id, file_id, scope, section_key, target_lang, total_count, filled_count, validator_histogram, revision, updated_at) VALUES
        ('pa','f1','file','', '', 10, 4, ?, 1, 1200)`,
    ).bind(JSON.stringify({ "0": 6, "1": 4 })).run()

    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string; lanes: Array<{ lane: string; name?: string | null }> }> }
    const pa = body.projects.find((p) => p.id === "pa")!
    expect(pa.lanes.map((l) => l.lane)).toEqual(["", "French"])
    expect(pa.lanes.find((l) => l.lane === "")?.name).toBe("Spanish")
  })

  it("AQU-1473: a primary stored as a language code still collapses onto the default lane", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings) VALUES ('pa', ?)",
    ).bind(JSON.stringify({ targetLanguage: "es", targetLanes: ["Spanish"] })).run()

    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string; lanes?: Array<{ lane: string }> }> }
    const pa = body.projects.find((p) => p.id === "pa")!
    expect(pa.lanes ?? []).toEqual([])
  })

  it("AQU-490: validatedAudioCells counts votes against the threshold, distinct from coverage", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e1', 1, 'pa', 'file.create', 'wendi', '{}', 1000, 1000, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO files (id, project_id, name, event_id, cell_count, approved_count, last_edit_at) VALUES ('f1', 'pa', 'GEN', 'e1', 100, 40, 1000)").run()
    // c1: selected, one vote             → audio-validated
    // c2: selected, no votes              → covered, not validated
    // c3: a validated take superseded by a re-record that has no votes yet
    //     → covered (the new selected take), NOT audio-validated
    // c4: deleted (excluded from both)
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cell_audio (project_id, file_id, cell_id, audio_id, slot, url, duration_ms, selected, deleted, validator_count, event_id, created_ts) VALUES
        ('pa','f1','c1','a1','recording','frontier-audio://a1.wav',60000,1,0,1,'ae1',1),
        ('pa','f1','c2','a2','recording','frontier-audio://a2.wav',30000,1,0,0,'ae2',1),
        ('pa','f1','c3','a3old','recording','frontier-audio://a3old.wav',30000,0,0,1,'ae3o',1),
        ('pa','f1','c3','a3new','recording','frontier-audio://a3new.wav',30000,1,0,0,'ae3n',1),
        ('pa','f1','c4','a4','recording','frontier-audio://a4.wav',99999,1,1,1,'ae4',1)`,
    ).run()

    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string; audioCells: number; validatedAudioCells: number }> }
    const pa = body.projects.find((p) => p.id === "pa")!
    // Coverage: c1, c2, c3 each have a selected dub (c4 deleted) → 3.
    expect(pa.audioCells).toBe(3)
    // Validated: only c1. c3's validated take is no longer selected, so the
    // re-record correctly drops it back to needing validation again.
    expect(pa.validatedAudioCells).toBe(1)
  })

  // AQU-490. Measured on this machine's dev database before the fix: a media
  // project reported 52.9 HOURS recorded and every cell covered, because one
  // imported programme clip is attached and selected on all of them and its
  // duration was counted once per cell. Nobody had dubbed a line of it.
  it("AQU-490: an imported source clip is neither coverage nor recorded time", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'Episode 1', 1, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e1', 1, 'pa', 'file.create', 'wendi', '{}', 1000, 1000, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO files (id, project_id, name, event_id, cell_count, approved_count, last_edit_at) VALUES ('f1', 'pa', 'EP1', 'e1', 3, 0, 1000)").run()
    // The same forty-minute clip on all three cells, as an import leaves it,
    // plus one real dub on c1.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cell_audio (project_id, file_id, cell_id, audio_id, slot, url, duration_ms, selected, deleted, role, validator_count, event_id, created_ts) VALUES
        ('pa','f1','c1','src','recording','frontier-audio://src.wav',2400000,1,0,'source',0,'ae1',1),
        ('pa','f1','c2','src','recording','frontier-audio://src.wav',2400000,1,0,'source',0,'ae1',1),
        ('pa','f1','c3','src','recording','frontier-audio://src.wav',2400000,1,0,'source',0,'ae1',1),
        ('pa','f1','c1','dub1','track-2','frontier-audio://dub1.wav',8000,1,0,'dub',1,'ae2',2)`,
    ).run()

    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    const body = (await res.json()) as { projects: Array<{ id: string; audioCells: number; validatedAudioCells: number; recordedMs: number }> }
    const pa = body.projects.find((p) => p.id === "pa")!
    expect(pa).toMatchObject({ audioCells: 1, validatedAudioCells: 1, recordedMs: 8000 })
  })

  // Two tracks sound together, so the weaker one governs. Without the MIN,
  // "some selected take is validated" would call c1 done while a whole track
  // went unheard.
  it("AQU-490: a multi-track cell is only as validated as its weakest track", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'Episode 1', 1, 1)").run()
    // This project asks for two validators on a recording.
    await env.AQUILLA_PG.prepare("INSERT INTO project_settings (project_id, settings) VALUES ('pa', ?)")
      .bind(JSON.stringify({ validationCountAudio: 2 })).run()
    await env.AQUILLA_PG.prepare("INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e1', 1, 'pa', 'file.create', 'wendi', '{}', 1000, 1000, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO files (id, project_id, name, event_id, cell_count, approved_count, last_edit_at) VALUES ('f1', 'pa', 'EP1', 'e1', 2, 0, 1000)").run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cell_audio (project_id, file_id, cell_id, audio_id, slot, url, duration_ms, selected, deleted, role, validator_count, event_id, created_ts) VALUES
        ('pa','f1','c1','a1','recording','frontier-audio://a1.wav',1000,1,0,'dub',3,'ae1',1),
        ('pa','f1','c1','a2','track-2','frontier-audio://a2.wav',1000,1,0,'dub',1,'ae2',2),
        ('pa','f1','c2','b1','recording','frontier-audio://b1.wav',1000,1,0,'dub',2,'ae3',3),
        ('pa','f1','c2','b2','track-2','frontier-audio://b2.wav',1000,1,0,'dub',2,'ae4',4)`,
    ).run()

    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    const body = (await res.json()) as { projects: Array<{ id: string; audioCells: number; validatedAudioCells: number }> }
    const pa = body.projects.find((p) => p.id === "pa")!
    // c1's second track has one vote against a threshold of two, so only c2
    // counts — even though c1's first track has three.
    expect(pa).toMatchObject({ audioCells: 2, validatedAudioCells: 1 })
  })

  // AQU-1083 — the org/project policy reaching the dashboard.
  async function seedStructuralOrg(orgSettings: string, projectSettings: string | null) {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_settings (org_id, settings, version) VALUES (1, ?, 0)").bind(orgSettings).run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)").run()
    if (projectSettings !== null) {
      await env.AQUILLA_PG.prepare("INSERT INTO project_settings (project_id, settings, version) VALUES ('pa', ?, 0)").bind(projectSettings).run()
    }
    await env.AQUILLA_PG.prepare("INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e1', 1, 'pa', 'file.create', 'wendi', '{}', 1000, 1000, 1)").run()
    // 10 cells, 2 of them structural; 6 filled of which 1 structural.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO files (id, project_id, name, event_id, cell_count, filled_count, approved_count, ai_drafted_count,
                          structural_cell_count, structural_filled_count, structural_approved_count, structural_ai_drafted_count, last_edit_at)
       VALUES ('f1','pa','GEN','e1', 10, 6, 4, 2,  2, 1, 1, 1, 1000)`,
    ).run()
    // One heading cell that was voiced, one verse that was voiced.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, type, event_id, last_edit_at)
       VALUES ('pa','f1','h1','source','Chapter 1','heading','e1',1),
              ('pa','f1','v1','source','In the beginning','verse','e1',1)`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cell_audio (project_id, file_id, cell_id, audio_id, slot, url, duration_ms, selected, deleted, validator_count, event_id, created_ts) VALUES
        ('pa','f1','h1','ah','generatedVoice','frontier-audio://h.wav',5000,1,0,1,'aeh',1),
        ('pa','f1','v1','av','recording','frontier-audio://v.wav',7000,1,0,1,'aev',1)`,
    ).run()
  }

  const portfolio = async () => {
    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<Record<string, number | string>> }
    return body.projects.find((p) => p.id === "pa")! as unknown as {
      totalCells: number; filledCells: number; validatedCells: number
      aiDraftedCells: number; audioCells: number; validatedAudioCells: number; recordedMs: number
    }
  }

  it("AQU-1083: counts headings by default, so nothing moves for an org that never opts out", async () => {
    await seedStructuralOrg("{}", null)
    const pa = await portfolio()
    expect(pa.totalCells).toBe(10)
    expect(pa.filledCells).toBe(6)
    expect(pa.audioCells).toBe(2)
  })

  it("AQU-1083: an org that opts out drops structural cells from every rollup", async () => {
    await seedStructuralOrg(JSON.stringify({ countStructuralCells: false }), null)
    const pa = await portfolio()
    expect(pa.totalCells).toBe(8)
    expect(pa.filledCells).toBe(5)
    expect(pa.validatedCells).toBe(3)
    expect(pa.aiDraftedCells).toBe(1)
  })

  it("AQU-1083: audio follows the same policy, so coverage can never exceed the total", async () => {
    // The trap this closes: audioPct divides audio cells by the TEXT total.
    // Excluding the heading from the denominator while its generated take
    // stayed in the numerator would read as more than 100% covered.
    await seedStructuralOrg(JSON.stringify({ countStructuralCells: false }), null)
    const pa = await portfolio()
    expect(pa.audioCells).toBe(1)
    expect(pa.validatedAudioCells).toBe(1)
    expect(pa.audioCells).toBeLessThanOrEqual(pa.totalCells)
  })

  it("AQU-1083: recorded minutes are work done, not progress, so they never move", async () => {
    await seedStructuralOrg(JSON.stringify({ countStructuralCells: false }), null)
    const pa = await portfolio()
    expect(pa.recordedMs).toBe(12000)
  })

  it("AQU-1083: a project's own answer overrides its org's", async () => {
    await seedStructuralOrg(
      JSON.stringify({ countStructuralCells: false }),
      JSON.stringify({ countStructuralCells: true }),
    )
    const pa = await portfolio()
    expect(pa.totalCells).toBe(10)
    expect(pa.audioCells).toBe(2)
  })

  it("AQU-1083: only the project that opts out loses its headings, not the sibling beside it", async () => {
    // structural_cells picks its projects by id — the excluding ones, as an
    // array — instead of joining to the policy (see the note above
    // portfolioCtes for why). Both halves have to hold in ONE request: the
    // project that opted out still drops its voiced heading, and a project
    // beside it that counts headings keeps its own.
    await seedStructuralOrg("{}", JSON.stringify({ countStructuralCells: false }))
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pb', 'Mark', 1, 1)").run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO files (id, project_id, name, event_id, cell_count, filled_count, approved_count, ai_drafted_count,
                          structural_cell_count, structural_filled_count, structural_approved_count, structural_ai_drafted_count, last_edit_at)
       VALUES ('f2','pb','MRK','e1', 10, 6, 4, 2,  2, 1, 1, 1, 1000)`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cells (project_id, file_id, cell_id, side, value, type, event_id, last_edit_at)
       VALUES ('pb','f2','h1','source','Chapter 1','heading','e1',1),
              ('pb','f2','v1','source','The beginning of the gospel','verse','e1',1)`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cell_audio (project_id, file_id, cell_id, audio_id, slot, url, duration_ms, selected, deleted, validator_count, event_id, created_ts) VALUES
        ('pb','f2','h1','bh','generatedVoice','frontier-audio://bh.wav',5000,1,0,1,'beh',1),
        ('pb','f2','v1','bv','recording','frontier-audio://bv.wav',7000,1,0,1,'bev',1)`,
    ).run()

    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      projects: Array<{ id: string; totalCells: number; audioCells: number }>
    }
    expect(body.projects.find((p) => p.id === "pa")).toMatchObject({ totalCells: 8, audioCells: 1 })
    expect(body.projects.find((p) => p.id === "pb")).toMatchObject({ totalCells: 10, audioCells: 2 })
  })

  it("AQU-1083: the per-lane breakdown subtracts the same cells as the headline", async () => {
    // Caught on a real imported Genesis: the scalar totals dropped from 1540 to
    // 1533 while the lane row under them still read 1540. The lane rollup is a
    // separate query over file_section_progress and had no idea about the
    // policy, so one project reported two different denominators at once.
    await seedStructuralOrg(JSON.stringify({ countStructuralCells: false }), null)
    await env.AQUILLA_PG.prepare(
      `INSERT INTO file_section_progress
         (project_id, file_id, scope, section_key, target_lang, total_count, filled_count,
          validator_histogram, structural_count, structural_filled_count,
          structural_validator_histogram, revision, updated_at)
       VALUES ('pa','f1','file','', '', 10, 6, ?, 2, 1, ?, 1, 1500)`,
    ).bind(
      JSON.stringify({ "0": 4, "1": 6 }),
      JSON.stringify({ "0": 1, "1": 1 }),
    ).run()

    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    const body = (await res.json()) as {
      projects: Array<{ id: string; totalCells: number; filledCells: number; validatedCells: number
                        lanes: Array<{ lane: string; totalCells: number; filledCells: number; validatedCells: number }> }>
    }
    const pa = body.projects.find((p) => p.id === "pa")!
    expect(pa.lanes[0]).toMatchObject({ lane: "", totalCells: 8, filledCells: 5, validatedCells: 5 })
    // And it agrees with the numbers printed beside it.
    expect(pa.lanes[0].totalCells).toBe(pa.totalCells)
    expect(pa.lanes[0].filledCells).toBe(pa.filledCells)
  })

  it("AQU-1083: a lane keeps its numbers when the project counts headings", async () => {
    await seedStructuralOrg("{}", null)
    await env.AQUILLA_PG.prepare(
      `INSERT INTO file_section_progress
         (project_id, file_id, scope, section_key, target_lang, total_count, filled_count,
          validator_histogram, structural_count, structural_filled_count,
          structural_validator_histogram, revision, updated_at)
       VALUES ('pa','f1','file','', '', 10, 6, ?, 2, 1, ?, 1, 1500)`,
    ).bind(
      JSON.stringify({ "0": 4, "1": 6 }),
      JSON.stringify({ "0": 1, "1": 1 }),
    ).run()

    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("wendi")) }, env)
    const body = (await res.json()) as {
      projects: Array<{ id: string; lanes: Array<{ lane: string; totalCells: number; filledCells: number; validatedCells: number }> }>
    }
    expect(body.projects.find((p) => p.id === "pa")!.lanes[0])
      .toMatchObject({ lane: "", totalCells: 10, filledCells: 6, validatedCells: 6 })
  })
})

describe("POST /api/v2/orgs/portfolio", () => {
  it("runs one set-based database aggregate for all unique organizations", async () => {
    const all = vi.fn().mockResolvedValue({ results: [] })
    const aggregateOrgBinds: unknown[][] = []
    const preparedQueries: string[] = []
    const prepare = vi.fn((query: string) => ({
      bind: (...args: unknown[]) => {
        preparedQueries.push(query)
        if (query.includes("au AS MATERIALIZED")) aggregateOrgBinds.push(args)
        return { all }
      },
    }))
    const fakeEnv = { AQUILLA_PG: { prepare } } as unknown as Env

    await getOrgPortfolios(fakeEnv, [2, 1, 2], { userId: 99, isAdmin: false }, Date.parse("2026-09-02T09:00:00Z"))

    // AQU-745: the aggregate carries the org binds for each IN clause plus the
    // per-caller visibility binds appended by PORTFOLIO_VISIBILITY_PREDICATE:
    // <isAdmin 0/1>, then userId ×4.
    //
    // Four org scopes, in order: the AQU-1083 policy CTE, the audio scope, the
    // AQU-1097 plan-unit counts (preceded by the Anywhere-on-Earth cutoff date
    // those counts compare target dates to), then the outer WHERE.
    expect(aggregateOrgBinds).toEqual([[2, 1, 2, 1, "2026-09-01", 2, 1, 2, 1, 0, 99, 99, 99, 99]])
    // Driven FROM projects and left-joined to its settings, so a project with
    // no settings row still inherits the org's structural-cell answer.
    const settingsQuery = preparedQueries.find((query) => query.includes("ps.target_lanes"))
    expect(settingsQuery).toContain("ps.validation_count")
    expect(settingsQuery).toContain("ps.target_lanes")
    expect(settingsQuery).toContain("ps.archived_lanes")
    expect(settingsQuery).toContain("COALESCE(ps.count_structural, os.count_structural, 'true')")
    // Still reads the generated columns rather than parsing the blob. The
    // archived-lane list was the one that slipped: read as
    // (ps.settings::jsonb)->'archivedLanes', it cost this request 4 seconds.
    expect(settingsQuery).not.toMatch(/ps\.settings\b/)
    expect(settingsQuery).not.toContain("::jsonb")
  })

  // The all-organizations dashboard timed out at the SPA's 15s abort on
  // 2026-10-05 for a caller with 8 orgs and 433 projects, while each org on
  // its own loaded in a second or two. A plan like that cannot be reproduced
  // at fixture scale — PGlite reads a ten-row table the same way whatever the
  // SQL says — so the two shapes behind it are pinned as text here, and the
  // behaviour they must keep is tested against a real database below. The
  // measurements are in the note above portfolioCtes.
  it("reads cells only for projects that exclude structural cells, and never probes files per row", async () => {
    const preparedQueries: string[] = []
    const prepare = vi.fn((query: string) => ({
      bind: () => {
        preparedQueries.push(query)
        return { all: vi.fn().mockResolvedValue({ results: [] }) }
      },
    }))
    const fakeEnv = { AQUILLA_PG: { prepare } } as unknown as Env

    await getOrgPortfolios(fakeEnv, [1, 2], { userId: 99, isAdmin: true })

    const aggregate = preparedQueries.find((query) => query.includes("au AS MATERIALIZED"))!
    const structuralCells = aggregate.slice(
      aggregate.indexOf("structural_cells AS ("),
      aggregate.indexOf("au_cells AS MATERIALIZED"),
    )
    // Joined to the policy, nothing made Postgres look at the (usually empty)
    // set of excluding projects before it read `cells`, and one added
    // predicate was enough to make it read all 2.2M pages first. An array is
    // resolved before the scan starts: empty means no read at all.
    expect(structuralCells).toContain("c.project_id = ANY(ARRAY(")
    expect(structuralCells).not.toMatch(/JOIN\s+policy/)
    // The counted-files rule (AQU-1626) is one small set built once for the
    // page. As a correlated probe it ran once per audio take — ~140k times.
    expect(aggregate).toContain("uncounted_files AS MATERIALIZED")
    expect(aggregate).not.toMatch(/FROM files uncounted_file\b/)
  })

  it("returns one bounded portfolio per requested organization", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1), (2, 'Waha', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (2, 1, 700, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1), ('pb', 'Luke', 2, 1)",
    ).run()

    const res = await app.request(
      "/api/v2/orgs/portfolio",
      {
        method: "POST",
        headers: { ...authHeader(await jwtFor("wendi")), "Content-Type": "application/json" },
        body: JSON.stringify({ orgIds: [2, 1, 2] }),
      },
      env,
    )

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      portfolios: Array<{ orgId: number; projects: Array<{ id: string; name: string }> }>
      nextCursor: string | null
    }
    expect(body.portfolios).toEqual([
      { orgId: 2, projects: [expect.objectContaining({ id: "pb", name: "Luke" })] },
      { orgId: 1, projects: [expect.objectContaining({ id: "pa", name: "John" })] },
    ])
    expect(body.nextCursor).toBeNull()
  })

  it("pages and searches with limit/cursor/q instead of dumping every project", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1), ('pb', 'Mark', 1, 1), ('pc', 'Acts', 1, 1)",
    ).run()

    const first = await app.request("/api/v2/orgs/1/portfolio?limit=1", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as {
      projects: Array<{ id: string; name: string }>
      nextCursor: string | null
    }
    expect(firstBody.projects).toEqual([expect.objectContaining({ id: "pc", name: "Acts" })])
    expect(firstBody.nextCursor).toBeTruthy()

    const second = await app.request(
      `/api/v2/orgs/1/portfolio?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    const secondBody = (await second.json()) as {
      projects: Array<{ id: string; name: string }>
      nextCursor: string | null
    }
    expect(secondBody.projects).toEqual([expect.objectContaining({ id: "pa", name: "John" })])
    expect(secondBody.nextCursor).toBeTruthy()

    const search = await app.request("/api/v2/orgs/1/portfolio?q=mar", { headers: authHeader(await jwtFor("wendi")) }, env)
    const searchBody = (await search.json()) as { projects: Array<{ id: string; name: string }> }
    expect(searchBody.projects).toEqual([expect.objectContaining({ id: "pb", name: "Mark" })])

    const batched = await app.request(
      "/api/v2/orgs/portfolio",
      {
        method: "POST",
        headers: { ...authHeader(await jwtFor("wendi")), "Content-Type": "application/json" },
        body: JSON.stringify({ orgIds: [1], limit: 1 }),
      },
      env,
    )
    const batchedBody = (await batched.json()) as {
      portfolios: Array<{ orgId: number; projects: Array<{ id: string; name: string }> }>
      nextCursor: string | null
    }
    expect(batchedBody.portfolios).toEqual([
      { orgId: 1, projects: [expect.objectContaining({ id: "pc", name: "Acts" })] },
    ])
    expect(batchedBody.nextCursor).toBeTruthy()
  })

  it("accepts more than 100 membership orgIds so all-orgs dashboards do not 400 (AQU-756)", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare(
      `INSERT INTO organizations (id, name, owner_user_id)
       SELECT g, 'Org ' || g, 1 FROM generate_series(1, 101) AS g`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO org_members (org_id, user_id, role_level, granted_by)
       SELECT g, 1, 700, 1 FROM generate_series(1, 101) AS g`,
    ).run()
    const orgIds = Array.from({ length: 101 }, (_, i) => i + 1)
    const res = await app.request(
      "/api/v2/orgs/portfolio",
      {
        method: "POST",
        headers: { ...authHeader(await jwtFor("wendi")), "Content-Type": "application/json" },
        body: JSON.stringify({ orgIds }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { portfolios: Array<{ orgId: number }> }
    expect(body.portfolios).toHaveLength(101)
  })

  it("omitted orgIds rolls up every membership (AQU-756)", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1), (2, 'Waha', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (2, 1, 700, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1), ('pb', 'Luke', 2, 1)",
    ).run()

    const res = await app.request(
      "/api/v2/orgs/portfolio",
      {
        method: "POST",
        headers: { ...authHeader(await jwtFor("wendi")), "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 40 }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      portfolios: Array<{ orgId: number; projects: Array<{ id: string }> }>
    }
    const byOrg = Object.fromEntries(body.portfolios.map((p) => [p.orgId, p.projects.map((r) => r.id)]))
    expect(byOrg[1]).toEqual(["pa"])
    expect(byOrg[2]).toEqual(["pb"])
  })
})

// AQU-745: the org dashboard portfolio must not leak the name of every project
// to a regular member. Visibility mirrors GET /api/v2/projects — a
// sub-maintainer sees only projects reached via creator / direct / group; the
// org path (blanket visibility) fires only at Maintainer+ (600).
describe("AQU-745 — portfolio project-name visibility floor", () => {
  // org 1: owner=1, maintainer=3 (600), contributor=2 (400).
  // projects pa/pb/pc all org-owned by user 1; contributor has a direct grant
  // to pc only (and no path to pa/pb).
  async function seedOrg() {
    await seedUser(1, "owner")
    await seedUser(2, "contributor")
    await seedUser(3, "maintainer")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1), (1, 3, 600, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'Algerian', 1, 1), ('pb', 'Bambara', 1, 1), ('pc', 'Cebuano', 1, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pc', 2, 400, 1)",
    ).run()
  }

  async function portfolioNames(username: string): Promise<string[]> {
    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor(username)) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string; name: string }> }
    return body.projects.map((p) => p.name).sort()
  }

  it("a Contributor sees ONLY projects they're assigned to (not every org project)", async () => {
    await seedOrg()
    expect(await portfolioNames("contributor")).toEqual(["Cebuano"])
  })

  it("a Maintainer still sees every project in the org (AQU-435 oversight)", async () => {
    await seedOrg()
    expect(await portfolioNames("maintainer")).toEqual(["Algerian", "Bambara", "Cebuano"])
  })

  it("the Owner still sees every project in the org", async () => {
    await seedOrg()
    expect(await portfolioNames("owner")).toEqual(["Algerian", "Bambara", "Cebuano"])
  })

  it("a Contributor with NO project path sees an empty portfolio (no name leak)", async () => {
    await seedUser(1, "owner2")
    await seedUser(2, "lonely")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'Algerian', 1, 1), ('pb', 'Bambara', 1, 1)",
    ).run()
    const res = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("lonely")) }, env)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { projects: unknown[] }).projects).toHaveLength(0)
  })

  it("the batched POST /orgs/portfolio applies the same per-caller visibility floor", async () => {
    await seedOrg()
    const res = await app.request(
      "/api/v2/orgs/portfolio",
      {
        method: "POST",
        headers: { ...authHeader(await jwtFor("contributor")), "Content-Type": "application/json" },
        body: JSON.stringify({ orgIds: [1] }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { portfolios: Array<{ orgId: number; projects: Array<{ name: string }> }> }
    expect(body.portfolios[0].projects.map((p) => p.name)).toEqual(["Cebuano"])
  })

  it("a group (team) grant reveals exactly the granted project in the portfolio", async () => {
    await seedUser(1, "owner3")
    await seedUser(2, "teamie")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'Algerian', 1, 1), ('pb', 'Bambara', 1, 1)",
    ).run()
    const grp = await env.AQUILLA_PG.prepare(
      "INSERT INTO groups (org_id, name, created_by) VALUES (1, 'Team A', 1) RETURNING id",
    ).first<{ id: number }>()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO group_members (group_id, user_id, added_by) VALUES (?, 2, 1)",
    ).bind(grp!.id).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (?, 'pb', 400, 1)",
    ).bind(grp!.id).run()
    expect(await portfolioNames("teamie")).toEqual(["Bambara"])
  })
})

// AQU-1097: planning-unit counts on the portfolio, so the org projects table
// can answer "which units are done" without opening every project.
describe("plan unit rollup", () => {
  const sql = (q: string) => env.AQUILLA_PG.prepare(q).run()

  async function seedOrg() {
    await seedUser(1, "wendi")
    await sql("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)")
    await sql("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)")
    await sql("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'Tok Pisin', 1, 1)")
    await sql("INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e1', 1, 'pa', 'file.create', 'wendi', '{}', 1, 1, 1)")
  }

  const progress = (fileId: string, scope: string, key: string) =>
    sql(`INSERT INTO file_section_progress (project_id, file_id, scope, section_key, target_lang, total_count, filled_count, validator_histogram, revision, updated_at)
         VALUES ('pa', '${fileId}', '${scope}', '${key}', '', 10, 0, '{}', 1, 1)`)

  async function portfolio(now?: number) {
    const rows = await getOrgPortfolios(env as unknown as Env, [1], { userId: 1, isAdmin: false }, now)
    return rows.find((r) => r.id === "pa")!
  }

  it("counts one unit per book for a Scripture file, and no file-grain unit", async () => {
    await seedOrg()
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count) VALUES ('f1', 'pa', 'Bible', 'e1', 40)")
    await progress("f1", "file", "")
    await progress("f1", "book", "GEN")
    await progress("f1", "book", "EXO")
    expect(await portfolio()).toMatchObject({ unitsTotal: 2, unitsDone: 0, unitsOverdue: 0 })
  })

  it("counts a non-Scripture file as one unit", async () => {
    await seedOrg()
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count) VALUES ('f1', 'pa', 'Episode 1', 'e1', 12)")
    await progress("f1", "file", "")
    expect(await portfolio()).toMatchObject({ unitsTotal: 1 })
  })

  it("excludes tombstoned files and hidden timeline content from the total", async () => {
    await seedOrg()
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count) VALUES ('live', 'pa', 'Live', 'e1', 5)")
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count, deleted_at) VALUES ('gone', 'pa', 'Gone', 'e1', 5, 123)")
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count, role) VALUES ('cue', 'pa', 'Cues', 'e1', 5, 'audio-cues')")
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count, role) VALUES ('caption-track', 'pa', 'Caption track', 'e1', 5, 'timeline-content')")
    expect(await portfolio()).toMatchObject({ unitsTotal: 1 })
  })

  // AQU-1626: the unit count above has applied the rule since AQU-1097, but the
  // CELL rollups rendered on the same row had no such filter — so a linked
  // video's 500-cue caption track added 500 untranslated cells to the org
  // dashboard and the project read as barely started, two tiles away from a
  // plan board showing the truth. Deleted files inflated it the same way.
  it("keeps tombstoned files and hidden companions out of the cell rollups and the lane chips", async () => {
    await seedOrg()
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count, filled_count, approved_count) VALUES ('live', 'pa', 'Live', 'e1', 10, 4, 2)")
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count, filled_count, approved_count, deleted_at) VALUES ('gone', 'pa', 'Gone', 'e1', 7, 7, 7, 123)")
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count, filled_count, role) VALUES ('cue', 'pa', 'Cues', 'e1', 500, 0, 'audio-cues')")
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count, filled_count, role) VALUES ('caption-track', 'pa', 'Caption track', 'e1', 500, 0, 'timeline-content')")
    for (const fileId of ["live", "gone", "cue", "caption-track"]) await progress(fileId, "file", "")
    const row = await portfolio()
    expect(row).toMatchObject({ totalCells: 10, filledCells: 4, validatedCells: 2 })
    // The lane chip reads file_section_progress rather than files, so it is a
    // separate path to the same wrong number: one progress row per file per
    // lane means four rows here and only one of them is work.
    expect(row.lanes.find((lane) => lane.lane === "")).toMatchObject({ totalCells: 10 })
  })

  // AQU-1626 applied the same rule to the AUDIO rollup, through a different
  // door: a take is keyed by file but never joined to `files`, so it is
  // filtered against the uncounted-files set (inCountedFileSetSql). That half
  // shipped without a test, and it is the half whose first form — a probe per
  // take — took this endpoint past the SPA's 15s abort.
  const take = (fileId: string, cellId: string, durationMs: number) =>
    sql(`INSERT INTO cell_audio (project_id, file_id, cell_id, audio_id, slot, url, duration_ms, selected, deleted, validator_count, event_id, created_ts)
         VALUES ('pa', '${fileId}', '${cellId}', 'a-${fileId}-${cellId}', 'recording', 'frontier-audio://${fileId}-${cellId}.wav', ${durationMs}, 1, 0, 1, 'ea-${fileId}-${cellId}', 1)`)

  it("keeps takes in tombstoned files and hidden companions out of audio coverage and recorded time", async () => {
    await seedOrg()
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count) VALUES ('live', 'pa', 'Live', 'e1', 10)")
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count, deleted_at) VALUES ('gone', 'pa', 'Gone', 'e1', 7, 123)")
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count, role) VALUES ('cue', 'pa', 'Cues', 'e1', 500, 'audio-cues')")
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count, role) VALUES ('caption-track', 'pa', 'Caption track', 'e1', 500, 'timeline-content')")
    await take("live", "c1", 4000)
    await take("gone", "c1", 9000)
    await take("cue", "c1", 9000)
    await take("caption-track", "c1", 9000)
    // One take is work. The other three are a deleted file's and two cue
    // sheets', and their 27 seconds are not time the project has banked.
    expect(await portfolio()).toMatchObject({ audioCells: 1, validatedAudioCells: 1, recordedMs: 4000 })
  })

  it("still counts a take whose file row is missing", async () => {
    // The set holds the UNCOUNTED files and takes are anti-joined against it,
    // so only a file that is present and uncounted removes anything. Built the
    // other way round — keep takes whose file is in a set of counted files — a
    // projection holding a take before its file would silently lose the work.
    await seedOrg()
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count) VALUES ('live', 'pa', 'Live', 'e1', 10)")
    await take("live", "c1", 4000)
    await take("not-projected-yet", "c1", 3000)
    expect(await portfolio()).toMatchObject({ audioCells: 2, recordedMs: 7000 })
  })

  it("counts a unit as done from its explicit mark", async () => {
    await seedOrg()
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count) VALUES ('f1', 'pa', 'Mark', 'e1', 10)")
    await sql("INSERT INTO plan_units (project_id, file_id, section_key, done_at, done_by, updated_at) VALUES ('pa', 'f1', '', 999, 'randall', 999)")
    expect(await portfolio()).toMatchObject({ unitsTotal: 1, unitsDone: 1 })
  })

  it("is not overdue on the target day anywhere on Earth, and is the day after", async () => {
    // Same Anywhere-on-Earth rule the project deadline uses: a unit due on a
    // date is late only once that date has ended in UTC-12.
    await seedOrg()
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count) VALUES ('f1', 'pa', 'Mark', 'e1', 10)")
    await sql("INSERT INTO plan_units (project_id, file_id, section_key, target_date, updated_at) VALUES ('pa', 'f1', '', '2026-09-02', 1)")
    const during = Date.parse("2026-09-02T23:00:00Z") // still the 2nd in UTC-12
    const after = Date.parse("2026-09-04T00:00:00Z")
    expect((await portfolio(during)).unitsOverdue).toBe(0)
    expect((await portfolio(after)).unitsOverdue).toBe(1)
  })

  it("never counts a done unit as overdue, however old its target", async () => {
    await seedOrg()
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count) VALUES ('f1', 'pa', 'Mark', 'e1', 10)")
    await sql("INSERT INTO plan_units (project_id, file_id, section_key, target_date, done_at, done_by, updated_at) VALUES ('pa', 'f1', '', '2020-01-01', 5, 'randall', 5)")
    expect(await portfolio()).toMatchObject({ unitsDone: 1, unitsOverdue: 0 })
  })

  it("reports zeroes for a project with no files", async () => {
    await seedOrg()
    expect(await portfolio()).toMatchObject({ unitsTotal: 0, unitsDone: 0, unitsOverdue: 0 })
  })
})

/**
 * AQU-1071 — the org's active-lane count, served beside the rollup.
 *
 * This is the number the enterprise billing band is read off, so it is counted by
 * the same helper billing counts with (`countTargetLanesByOrg`): unarchived
 * target lane rows. Archived projects and paused (`is_active = false`, AQU-1070)
 * projects are excluded. The tile reads it from here rather than from the lane
 * chips on screen.
 */
describe("GET /api/v2/orgs/:orgId/portfolio — activeLanguageCount (AQU-1071)", () => {
  async function seedOrgWithLanes() {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO projects (id, name, org_id, created_by, archived_at) VALUES
        ('pa', 'John', 1, 1, NULL),
        ('pb', 'Mark', 1, 1, NULL),
        ('pc', 'Luke', 1, 1, NULL),
        ('pz', 'Retired', 1, 1, '2026-01-01')`,
    ).run()
    // Settings disagree with the lane rows on purpose: billing must follow lanes.
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_settings (project_id, settings, version) VALUES
        ('pa', '{"targetLanguage":"Bambara","targetLanes":["Dioula"]}', 1),
        ('pb', '{"targetLanguage":"Bambara"}', 1),
        ('pc', '{"targetLanguage":"Fulfulde","targetLanes":["Songhai","Ignored"],"archivedLanes":["Songhai"]}', 1),
        ('pz', '{"targetLanguage":"Zarma"}', 1)`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, archived_at) VALUES
        ('eslane01', 'pa', 'target', 'Spanish', 'es', '', NULL),
        ('eslane02', 'pa', 'target', 'Spanish', 'es', 'es-b', NULL),
        ('eslane03', 'pa', 'target', 'Spanish', 'es', 'es-c', NULL),
        ('frlane01', 'pb', 'target', 'French', 'fr', '', NULL),
        ('fflane01', 'pc', 'target', 'Fulfulde', 'ff', '', '2026-01-01'),
        ('zrlane01', 'pz', 'target', 'Zarma', 'dje', '', NULL)`,
    ).run()
  }

  async function languageCount(): Promise<number> {
    const res = await app.request(
      "/api/v2/orgs/1/portfolio",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    return ((await res.json()) as { activeLanguageCount: number }).activeLanguageCount
  }

  it("counts each active target lane, including two lanes of one language", async () => {
    await seedOrgWithLanes()
    // pa has three Spanish lanes. pb has one French lane. pc's only lane is
    // archived, and pz's project is archived, so neither adds a lane.
    expect(await languageCount()).toBe(4)
  })

  it("is zero for an org with no projects, rather than absent", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    expect(await languageCount()).toBe(0)
  })

  it("is org-wide, so a filtered page of projects does not shrink it", async () => {
    // The tile must agree with the invoice whatever the table is showing, so the
    // count is deliberately not scoped to the requested page or search.
    await seedOrgWithLanes()
    const res = await app.request(
      "/api/v2/orgs/1/portfolio?q=john&limit=1",
      { headers: authHeader(await jwtFor("wendi")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: unknown[]; activeLanguageCount: number }
    expect(body.projects).toHaveLength(1)
    expect(body.activeLanguageCount).toBe(4)
  })
})

describe("AQU-1421 portfolio lane visibility", () => {
  const sql = (q: string) => env.AQUILLA_PG.prepare(q).run()

  async function seedSplitProject() {
    await seedUser(1, "owner")
    await seedUser(2, "translator")
    await sql("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)")
    await sql("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 400, 1)")
    await sql("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'Tok Pisin', 1, 1)")
    await sql("INSERT INTO project_members (project_id, user_id, role_level) VALUES ('pa', 2, 400)")
    await sql(
      `INSERT INTO project_settings (project_id, settings, version) VALUES ('pa', '{"targetLanguage":"Spanish","targetLanes":["es"]}', 1)`,
    )
    await sql("INSERT INTO lanes (id, project_id, role, name, legacy_tag) VALUES ('deflane1', 'pa', 'target', 'Spanish', ''), ('eslane01', 'pa', 'target', 'Spanish Team', 'es')")
    await sql("INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level) VALUES ('pa', 2, 'eslane01', 400)")
    await sql("INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e1', 1, 'pa', 'file.create', 'owner', '{}', 1, 1, 1)")
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count, filled_count, ai_drafted_count, last_edit_at) VALUES ('f1', 'pa', 'Episode 1', 'e1', 80, 20, 5, 9000)")
    await sql(
      `INSERT INTO file_section_progress (project_id, file_id, scope, section_key, target_lang, total_count, filled_count, validator_histogram, updated_at)
       VALUES ('pa', 'f1', 'file', '', '', 70, 20, '{}', 8000),
              ('pa', 'f1', 'file', '', 'es', 10, 3, '{}', 1000)`,
    )
    await sql(
      `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_edit_at, ai_drafted) VALUES
        ('pa', 'f1', 'c-hidden', 'target', '', 'draft', 'e1', 1, 1),
        ('pa', 'f1', 'c-mine', 'target', 'es', 'draft', 'e1', 1, 1)`,
    )
    await sql(
      `INSERT INTO cell_audio (project_id, file_id, cell_id, audio_id, slot, url, duration_ms, selected, deleted, event_id, created_ts)
       VALUES ('pa', 'f1', 'c-mine', 'a1', 'recording', 'frontier-audio://a1.wav', 1000, 1, 0, 'e1', 1)`,
    )
  }

  async function rowFor(userId: number) {
    const rows = await getOrgPortfolios(env as unknown as Env, [1], { userId, isAdmin: false })
    return rows.find((row) => row.id === "pa")!
  }

  it("hides the ungranted lane's name, text totals, and default language, and keeps audio and plan units", async () => {
    await seedSplitProject()
    env.LANE_READ_WALL = "1"
    try {
      const translator = await rowFor(2)
      expect(translator.lanes.map((lane) => lane.lane)).toEqual(["es"])
      expect(translator).toMatchObject({
        totalCells: 10,
        filledCells: 3,
        validatedCells: 0,
        aiDraftedCells: 1,
        lastEditAt: 1000,
        targetLanguage: null,
        sourceLanguage: null,
        audioCells: 1,
        unitsTotal: 1,
      })
      expect(translator.lanes[0]).toMatchObject({ lane: "es", totalCells: 10, filledCells: 3 })

      const owner = await rowFor(1)
      expect(owner.lanes.map((lane) => lane.lane).sort()).toEqual(["", "es"])
      expect(owner).toMatchObject({
        totalCells: 80,
        aiDraftedCells: 5,
        lastEditAt: 9000,
        targetLanguage: "Spanish",
        audioCells: 1,
        unitsTotal: 1,
      })
    } finally {
      env.LANE_READ_WALL = undefined
    }
  })

  // The per-lane machine-draft count is the one number on this page that has
  // to be read from `cells`. It was a scan of the whole table on dev (2.28M
  // pages, 75s cold, to find 132 rows). These pin what it counts, then the
  // two things that keep it off that scan: the statement's shape and the index.
  describe("machine-drafted cells behind the wall", () => {
    async function drafted(cellId: string, fileId: string, lane = "es") {
      await sql(
        `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, event_id, last_edit_at, ai_drafted)
         VALUES ('pa', '${fileId}', '${cellId}', 'target', '${lane}', 'draft', 'e1', 1, 1)`,
      )
    }

    async function walledRow() {
      env.LANE_READ_WALL = "1"
      try {
        return await rowFor(2)
      } finally {
        env.LANE_READ_WALL = undefined
      }
    }

    it("counts drafts in the granted lane only, and only in files that count as work", async () => {
      await seedSplitProject()
      await sql(
        `INSERT INTO files (id, project_id, name, event_id, deleted_at, role) VALUES
           ('f-gone', 'pa', 'Deleted episode', 'e1', 5000, NULL),
           ('f-captions', 'pa', 'Caption track', 'e1', NULL, 'timeline-content')`,
      )
      await drafted("c-second", "f1")
      await drafted("c-in-deleted-file", "f-gone")
      await drafted("c-in-caption-track", "f-captions")
      // No files row at all: a projection that has the cell before its file
      // must not lose the work, so this one stays in (see inCountedFileSql).
      await drafted("c-file-not-projected-yet", "f-pending")
      // Another lane's draft in the same file is not this caller's to see.
      await drafted("c-other-lane", "f1", "")

      // c-mine (from the seed), c-second, and the one whose file is pending.
      expect((await walledRow()).aiDraftedCells).toBe(3)
    })

    it("drops a drafted heading exactly when the project leaves structural cells out", async () => {
      await seedSplitProject()
      await sql(
        `INSERT INTO cells (project_id, file_id, cell_id, side, target_lang, value, type, event_id, last_edit_at) VALUES
           ('pa', 'f1', 'c-heading', 'source', '', 'The Birth of Jesus', 'heading', 'e1', 1),
           ('pa', 'f1', 'c-mine', 'source', '', 'In those days', 'verse', 'e1', 1)`,
      )
      await drafted("c-heading", "f1")
      expect((await walledRow()).aiDraftedCells).toBe(2)

      await sql(
        `UPDATE project_settings
            SET settings = '{"targetLanguage":"Spanish","targetLanes":["es"],"countStructuralCells":false}'
          WHERE project_id = 'pa'`,
      )
      expect((await walledRow()).aiDraftedCells).toBe(1)
    })

    /** The statement aiDraftedByLane ran for the translator, with its binds. */
    async function draftedStatement() {
      const calls: { query: string; args: unknown[] }[] = []
      const db = {
        prepare(query: string) {
          const statement = env.AQUILLA_PG.prepare(query)
          return {
            bind(...args: unknown[]) {
              calls.push({ query, args })
              return statement.bind(...args)
            },
          }
        },
      }
      await getOrgPortfolios(
        { ...env, AQUILLA_PG: db, LANE_READ_WALL: "1" } as unknown as Env,
        [1],
        { userId: 2, isAdmin: false },
      )
      return calls.find((call) => call.query.includes("c.ai_drafted = 1"))!
    }

    it("names its projects to `cells` as an array, so the planner cannot choose to read the table", async () => {
      await seedSplitProject()
      const { query, args } = await draftedStatement()

      expect(args).toEqual(["pa"])
      // Joined to the policy and nothing else, `cells` was read in full for a
      // 155-project page (an index served a 52-project one). An array is
      // resolved before the scan and costed as a few lookups, whatever its
      // length.
      expect(query).toContain("c.project_id = ANY(ARRAY(SELECT project_id FROM pol))")
      // The counted-files rule as one small set, not a probe per drafted row.
      expect(query).toContain("uncounted_files AS MATERIALIZED")
      expect(query).not.toMatch(/FROM files uncounted_file\b/)
    })

    it("is answered from idx_cells_ai_drafted, whose predicate the statement spells out", async () => {
      await seedSplitProject()
      const { query, args } = await draftedStatement()

      // A partial index is usable only when the query implies its WHERE. If
      // either side is reworded the index silently stops applying and the
      // statement goes back to reading every target cell on the page.
      const index = await env.AQUILLA_PG.prepare(
        "SELECT indexdef FROM pg_indexes WHERE tablename = 'cells' AND indexname = 'idx_cells_ai_drafted'",
      ).first<{ indexdef: string }>()
      expect(index?.indexdef).toContain("(project_id, file_id) WHERE ((side = 'target'::text) AND (ai_drafted = 1))")
      expect(query).toContain("c.side = 'target' AND c.ai_drafted = 1")

      // Ten rows fit on one page, where a seq scan always looks cheapest, so
      // it is switched off to leave the planner the choice it has at 16M rows:
      // which index.
      if (!env.AQUILLA_PG.transaction) throw new Error("test database must support transactions")
      const plan = await env.AQUILLA_PG.transaction(async (tx) => {
        await tx.prepare("SET LOCAL enable_seqscan = off").run()
        return tx.prepare(`EXPLAIN (COSTS OFF) ${query}`).bind(...args).all<Record<string, unknown>>()
      })
      const rendered = plan.results.flatMap((row) => Object.values(row)).join("\n")
      expect(rendered).toMatch(/Scan using idx_cells_ai_drafted on cells c|Bitmap Index Scan on idx_cells_ai_drafted/)
      expect(rendered).not.toMatch(/Seq Scan on cells c\b/)
    })
  })

  it("leaves the cross-lane totals in place while the wall is off", async () => {
    await seedSplitProject()
    env.LANE_READ_WALL = undefined
    const translator = await rowFor(2)
    expect(translator.lanes.map((lane) => lane.lane).sort()).toEqual(["", "es"])
    expect(translator).toMatchObject({
      totalCells: 80,
      aiDraftedCells: 5,
      targetLanguage: "Spanish",
    })
  })

  // The wall asks one question per project: is this caller a Maintainer on it,
  // by any grant path? That is resolveProjectRole's question, and the page now
  // gets it answered for every project at once, so each path is walked here
  // through the dashboard itself.
  it("lifts the wall for a Maintainer role on the project whichever path grants it, and for nothing lower", async () => {
    await seedSplitProject()
    env.LANE_READ_WALL = "1"
    try {
      const lanes = async () => (await rowFor(2)).lanes.map((lane) => lane.lane).sort()
      expect(await lanes()).toEqual(["es"])

      // A team attached at Contributor changes nothing: still below the wall.
      await sql("INSERT INTO groups (id, org_id, name, created_by) VALUES (1, 1, 'Translators', 1)")
      await sql("INSERT INTO group_members (group_id, user_id, added_by) VALUES (1, 2, 1)")
      await sql("INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (1, 'pa', 400, 1)")
      expect(await lanes()).toEqual(["es"])

      // The same team at Maintainer wins over the direct Contributor row
      // (AD-12 max-wins), and the SQL totals come back with the lanes.
      await sql("UPDATE group_project_grants SET role_level = 600 WHERE group_id = 1 AND project_id = 'pa'")
      expect(await lanes()).toEqual(["", "es"])
      expect(await rowFor(2)).toMatchObject({ totalCells: 80, aiDraftedCells: 5, targetLanguage: "Spanish" })

      // And a direct Maintainer row does it with the team back at Contributor.
      await sql("UPDATE group_project_grants SET role_level = 400 WHERE group_id = 1 AND project_id = 'pa'")
      expect(await lanes()).toEqual(["es"])
      await sql("UPDATE project_members SET role_level = 600 WHERE project_id = 'pa' AND user_id = 2")
      expect(await lanes()).toEqual(["", "es"])
    } finally {
      env.LANE_READ_WALL = undefined
    }
  })

  // 2026-10-05: a caller with 155 projects below the wall cost 1,085 role
  // statements on this one request, four per project plus three more under
  // ACCESS_GRANTS_RESOLVER=shadow. Nothing on this path may grow with the page.
  it.each([undefined, "shadow", "on"])(
    "issues as many statements for four walled projects as for one (ACCESS_GRANTS_RESOLVER=%s)",
    async (resolver) => {
      await seedSplitProject()
      const walled = async () => {
        const statements: string[] = []
        const db = {
          prepare(query: string) {
            statements.push(query)
            return env.AQUILLA_PG.prepare(query)
          },
        }
        const rows = await getOrgPortfolios(
          { ...env, AQUILLA_PG: db, LANE_READ_WALL: "1", ACCESS_GRANTS_RESOLVER: resolver } as unknown as Env,
          [1],
          { userId: 2, isAdmin: false },
        )
        return { rows, statements }
      }

      const one = await walled()
      await sql("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pb', 'Bislama', 1, 1), ('pc', 'Hiri Motu', 1, 1), ('pd', 'Kuanua', 1, 1)")
      await sql("INSERT INTO project_members (project_id, user_id, role_level) VALUES ('pb', 2, 400), ('pc', 2, 400), ('pd', 2, 400)")
      const four = await walled()

      expect(one.rows.map((row) => row.id)).toEqual(["pa"])
      expect(four.rows.map((row) => row.id).sort()).toEqual(["pa", "pb", "pc", "pd"])
      // Every one of them is below the wall, so every one of them was resolved.
      expect(four.rows.find((row) => row.id === "pa")!.lanes.map((lane) => lane.lane)).toEqual(["es"])
      expect(four.statements).toHaveLength(one.statements.length)
    },
  )
})
