// AQU-1566: the numbers pushed to a Monday board count the same files as the
// org dashboard. A caption track's content file and a dubbing import's cue
// sheet are timeline data, not files of the project, so they never reach the
// board as an extra item or add their cues to the project's total.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { seedUser } from "./helpers/db"
import { computeProjectMetrics } from "../lib/monday/metrics"

describe("computeProjectMetrics", () => {
  it("AQU-1566: leaves deleted files, cue sheets and caption tracks out of the board", async () => {
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'Linked video', 1, 1)").run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES
        ('e1', 1, 'pa', 'file.create', 'wendi', '{}', 1000, 1000, 1), ('e2', 1, 'pa', 'file.create', 'wendi', '{}', 2000, 2000, 2),
        ('e3', 1, 'pa', 'file.create', 'wendi', '{}', 3000, 3000, 3), ('e4', 1, 'pa', 'file.create', 'wendi', '{}', 4000, 4000, 4)`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO files (id, project_id, name, role, anchor_file_id, event_id, cell_count, filled_count, approved_count, deleted_at) VALUES
        ('f1', 'pa', 'Episode 1', NULL, NULL, 'e1', 6, 3, 0, NULL),
        ('f-del', 'pa', 'Old', NULL, NULL, 'e2', 50, 50, 0, 1700000000000),
        ('f-cue', 'pa', 'Episode 1 audio', 'audio-cues', 'f1', 'e3', 40, 40, 0, NULL),
        ('f-track', 'pa', 'Episode captions', 'timeline-content', 'f1', 'e4', 500, 0, 0, NULL)`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO file_section_progress (project_id, file_id, scope, section_key, target_lang, total_count, filled_count, validator_histogram, updated_at) VALUES
        ('pa', 'f1', 'file', '', '', 6, 3, '{}', 1),
        ('pa', 'f-cue', 'file', '', '', 40, 40, '{}', 1),
        ('pa', 'f-track', 'file', '', '', 500, 0, '{}', 1)`,
    ).run()

    const summary = await computeProjectMetrics(env.AQUILLA_PG, "pa")
    expect(summary?.files.map((f) => f.fileId)).toEqual(["f1"])
    expect(summary?.project).toMatchObject({ total_count: 6, filled_count: 3, completion_pct: 50 })
  })
})
