import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

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
