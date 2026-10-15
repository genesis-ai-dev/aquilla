// AQU-1770: the project facts a Monday board can show beside the progress
// percentages, each read from the rule the dashboards already use: the plan
// board's units and counts (db/shared/plan-units.ts), the org dashboard's
// deadline and behind-plan flags (portfolioAttentionReasons), its "recorded"
// sum, and the app's lane labels.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { computeProjectMetrics } from "../lib/monday/metrics"

const NOW = Date.parse("2026-10-12T12:00:00Z")
const DAY = 24 * 60 * 60 * 1000
const opts = { appBaseUrl: "https://app.test/", now: NOW }

async function seed(project: { deadline?: string | null } = {}) {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO users (id, username, email, password_hash, preferences, display_name) VALUES
       (1, 'wendi', 'w@example.com', 'scrypt:fake$s$h', '{}', 'Wendi Ong'),
       (2, 'alice', 'a@example.com', 'scrypt:fake$s$h', '{}', NULL)`,
  ).run()
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by, pm_user_id, deadline_at) VALUES ('pa', 'Ruth', 1, 1, 1, ?)",
  )
    .bind(project.deadline ?? null)
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO lanes (id, project_id, role, language, name, position, archived_at) VALUES
       ('l0', 'pa', 'target', 'Spanish', NULL, 0, NULL),
       ('l1', 'pa', 'target', 'French', 'Français (Canada)', 1, NULL),
       ('l2', 'pa', 'target', 'German', NULL, 2, now())`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, event_id, cell_count) VALUES
       ('f1', 'pa', 'Ruth', 'e1', 10), ('f2', 'pa', 'Jonah', 'e2', 4)`,
  ).run()
  // f1 holds one book (RUT) that's under way; f2 has no books (a file-grain unit).
  await env.AQUILLA_PG.prepare(
    `INSERT INTO file_section_progress (project_id, file_id, scope, section_key, lane_id, total_count, filled_count, updated_at) VALUES
       ('pa', 'f1', 'file', '', 'l0', 10, 5, 1),
       ('pa', 'f1', 'book', 'RUT', 'l0', 10, 5, 1),
       ('pa', 'f2', 'file', '', 'l0', 4, 0, 1)`,
  ).run()
}

async function plan(rows: Array<[string, string, string | null, boolean]>) {
  for (const [fileId, sectionKey, target, done] of rows) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO plan_units (project_id, file_id, section_key, target_date, done_at, done_by, updated_at)
       VALUES ('pa', ?, ?, ?, ?, ?, 1)`,
    )
      .bind(fileId, sectionKey, target, done ? 1 : null, done ? "wendi" : null)
      .run()
  }
}

let seq = 0
async function event(id: string, author: string, ts: number) {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES (?, 1, 'pa', 'cell.edit', ?, '{}', ?, ?, ?)`,
  )
    .bind(id, author, ts, ts, ++seq)
    .run()
}

async function take(audioId: string, ms: number, opts: { selected?: boolean; role?: string } = {}) {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cell_audio (project_id, file_id, cell_id, audio_id, slot, url, selected, deleted, event_id, created_ts, duration_ms, role)
     VALUES ('pa', 'f1', ?, ?, 'recording', 'frontier-audio://x.wav', ?, 0, 'e', 1, ?, ?)`,
  )
    .bind(`c-${audioId}`, audioId, opts.selected === false ? 0 : 1, ms, opts.role ?? "dub")
    .run()
}

describe("Monday metrics — project facts (AQU-1770)", () => {
  it("reads every fact for the project, and a file row's own plan figures and link", async () => {
    await seed({ deadline: "2026-12-31" })
    await plan([
      ["f1", "RUT", "2026-12-01", false],
      ["f2", "", null, true],
    ])
    await event("e1", "wendi", NOW - 1 * DAY - 1000)
    await event("e2", "bob", NOW - 2 * DAY)
    await event("e3", "alice", NOW - 40 * DAY)
    await take("a1", 90_000)
    await take("a2", 30_000)
    await take("a3", 60_000, { selected: false })
    await take("a4", 600_000, { role: "source" })

    const summary = (await computeProjectMetrics(env.AQUILLA_PG, "pa", opts))!
    const p = summary.project
    expect(p.project_link).toBe("https://app.test/projects/pa")
    expect(p.schedule_status).toBe("On track")
    expect(p.books_done).toBe("1 of 2")
    expect(p.next_target_date).toBe("2026-12-01")
    expect(p.days_since_activity).toBe(1)
    expect(p.project_manager).toBe("Wendi Ong")
    expect(p.languages).toBe("Spanish, Français (Canada)")
    expect(p.active_contributors_30d).toBe(2)
    expect(p.books_in_progress).toBe("RUT")
    expect(p.recorded_minutes).toBe(2)

    const f1 = summary.files.find((f) => f.fileId === "f1")!.metrics
    const f2 = summary.files.find((f) => f.fileId === "f2")!.metrics
    expect(f1.project_link).toBe("https://app.test/project/pa/editor/file/f1")
    expect([f1.books_done, f1.next_target_date, f1.books_in_progress]).toEqual(["0 of 1", "2026-12-01", "RUT"])
    expect([f2.books_done, f2.next_target_date, f2.books_in_progress]).toEqual(["1 of 1", null, ""])
    // The rest is the project's on every row.
    expect([f2.project_manager, f2.languages, f2.recorded_minutes, f2.schedule_status]).toEqual([
      "Wendi Ong", "Spanish, Français (Canada)", 2, "On track",
    ])
  })

  it("schedule: Due soon inside 7 days, Behind plan when a unit is late, Overdue past the deadline", async () => {
    await seed({ deadline: "2026-10-16" })
    await plan([["f1", "RUT", "2026-12-01", false]])
    expect((await computeProjectMetrics(env.AQUILLA_PG, "pa", opts))!.project.schedule_status).toBe("Due soon")

    await env.AQUILLA_PG.prepare("UPDATE plan_units SET target_date = '2026-10-01'").run()
    expect((await computeProjectMetrics(env.AQUILLA_PG, "pa", opts))!.project.schedule_status).toBe("Behind plan")

    await env.AQUILLA_PG.prepare("UPDATE projects SET deadline_at = '2026-10-01'").run()
    expect((await computeProjectMetrics(env.AQUILLA_PG, "pa", opts))!.project.schedule_status).toBe("Overdue")
  })

  it("leaves facts empty when there's nothing to show", async () => {
    await seed()
    await env.AQUILLA_PG.prepare("UPDATE projects SET pm_user_id = NULL").run()
    const p = (await computeProjectMetrics(env.AQUILLA_PG, "pa", opts))!.project
    expect(p.schedule_status).toBe("On track")
    expect(p.books_done).toBe("0 of 2")
    expect(p.next_target_date).toBeNull()
    expect(p.days_since_activity).toBeNull()
    expect(p.project_manager).toBe("")
    expect(p.active_contributors_30d).toBe(0)
    expect(p.recorded_minutes).toBe(0)
    expect(p.books_in_progress).toBe("RUT")
  })
})
