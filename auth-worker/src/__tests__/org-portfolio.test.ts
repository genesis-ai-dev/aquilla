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

  it("includes per-project audio progress (distinct live cells + selected recorded ms)", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1), ('pb', 'Mark', 1, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e1', 1, 'pa', 'file.create', 'wendi', '{}', 1000, 1000, 1), ('e3', 1, 'pb', 'file.create', 'wendi', '{}', 500, 500, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO files (id, project_id, name, event_id, cell_count, approved_count, last_edit_at) VALUES ('f1', 'pa', 'GEN', 'e1', 100, 40, 1000), ('f3', 'pb', 'MRK', 'e3', 50, 50, 500)").run()
    // pa: c1+c2 selected recordings (90000ms); c3 unselected (counts as a cell w/ audio, not recorded ms); c4 deleted (excluded)
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
    expect(byId.pa).toMatchObject({ audioCells: 3, recordedMs: 90000 })
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

  it("AQU-508: validatedAudioCells counts cells whose selected clip is approved, distinct from coverage", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e1', 1, 'pa', 'file.create', 'wendi', '{}', 1000, 1000, 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO files (id, project_id, name, event_id, cell_count, approved_count, last_edit_at) VALUES ('f1', 'pa', 'GEN', 'e1', 100, 40, 1000)").run()
    // c1: selected + approved            → audio-validated
    // c2: selected, not approved         → covered, not validated
    // c3: approved but NOT selected (a re-record superseded the approved take)
    //     → covered (the new selected take), NOT audio-validated
    // c4: deleted (excluded from both)
    await env.AQUILLA_PG.prepare(
      `INSERT INTO cell_audio (project_id, file_id, cell_id, audio_id, slot, url, duration_ms, selected, deleted, approved, event_id, created_ts) VALUES
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
    // Coverage: c1, c2, c3 have a live clip (c4 deleted) → 3.
    expect(pa.audioCells).toBe(3)
    // Validated: only c1 (selected + approved). c3's approved take is no longer
    // selected, so the re-record correctly drops it back to needs-re-validation.
    expect(pa.validatedAudioCells).toBe(1)
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
        if (query.includes("WITH au AS MATERIALIZED")) aggregateOrgBinds.push(args)
        return { all }
      },
    }))
    const fakeEnv = { AQUILLA_PG: { prepare } } as unknown as Env

    await getOrgPortfolios(fakeEnv, [2, 1, 2], { userId: 99, isAdmin: false })

    // AQU-745: the aggregate carries the org binds (both IN clauses) plus the
    // per-caller visibility binds appended by PORTFOLIO_VISIBILITY_PREDICATE:
    // <isAdmin 0/1>, then userId ×4.
    expect(aggregateOrgBinds).toEqual([[2, 1, 2, 1, 0, 99, 99, 99, 99]])
    const settingsQuery = preparedQueries.find((query) => query.includes("FROM project_settings ps"))
    expect(settingsQuery).toContain("ps.validation_count")
    expect(settingsQuery).toContain("ps.target_lanes")
    expect(settingsQuery).not.toContain("ps.settings AS settings")
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
    }
    expect(body.portfolios).toEqual([
      { orgId: 2, projects: [expect.objectContaining({ id: "pb", name: "Luke" })] },
      { orgId: 1, projects: [expect.objectContaining({ id: "pa", name: "John" })] },
    ])
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
