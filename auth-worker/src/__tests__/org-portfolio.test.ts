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
      `INSERT INTO cell_audio (project_id, file_id, cell_id, audio_id, slot, url, duration_ms, selected, deleted, approved, event_id, created_ts) VALUES
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
    expect(settingsQuery).toContain("COALESCE(ps.count_structural, os.count_structural, 'true')")
    // Still reads the generated columns rather than parsing the blob.
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

  it("excludes tombstoned files and audio-cue siblings from the total", async () => {
    await seedOrg()
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count) VALUES ('live', 'pa', 'Live', 'e1', 5)")
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count, deleted_at) VALUES ('gone', 'pa', 'Gone', 'e1', 5, 123)")
    await sql("INSERT INTO files (id, project_id, name, event_id, cell_count, role) VALUES ('cue', 'pa', 'Cues', 'e1', 5, 'audio-cues')")
    expect(await portfolio()).toMatchObject({ unitsTotal: 1 })
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
