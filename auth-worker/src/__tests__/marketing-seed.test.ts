// AQU-552: the curated demo is seeded again at every marketing sign-in, and a
// recording run signs in once per take against one sync-worker.
import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import app from "../index"

async function seed(): Promise<void> {
  const res = await app.request("/__marketing__/seed", { method: "POST" }, env)
  expect(res.status, await res.clone().text()).toBe(200)
}

async function fileState(): Promise<{ maxSeq: number; cellIds: string[] }> {
  const seq = await env.AQUILLA_PG
    .prepare("SELECT COALESCE(MAX(server_seq), 0) AS m FROM events WHERE project_id = ? AND file_id = ?")
    .bind("demo-john", "demo-john-1")
    .first<{ m: number }>()
  const cells = await env.AQUILLA_PG
    .prepare("SELECT cell_id FROM cells WHERE project_id = ? AND file_id = ? AND side = 'source' ORDER BY cell_id")
    .bind("demo-john", "demo-john-1")
    .all<{ cell_id: string }>()
  return { maxSeq: Number(seq?.m ?? 0), cellIds: cells.results.map((row) => row.cell_id) }
}

describe("marketing seed", () => {
  beforeEach(() => { env.WRANGLER_LOCAL = "1" })
  afterEach(() => { env.WRANGLER_LOCAL = undefined })

  it("a re-seed starts the file clean: a higher server_seq for its new cells, and no old comments", async () => {
    await seed()
    const first = await fileState()
    // A comment left on the first seed's file, as a recorded take leaves one.
    await env.AQUILLA_PG
      .prepare(
        `INSERT INTO comments (comment_id, project_id, scope_kind, file_id, cell_id, body, author_id, created_at, updated_at)
         VALUES ('c1', 'demo-john', 'cell', 'demo-john-1', ?, 'left behind', 'demo', 1, 1)`,
      )
      .bind(first.cellIds[0])
      .run()

    await seed()
    const second = await fileState()

    expect(second.cellIds).toHaveLength(6)
    // New cell ids each time: whatever the sync-worker cached for the file
    // under the first seed's watermark must not be reachable under the second's.
    expect(second.cellIds).not.toEqual(first.cellIds)
    expect(second.maxSeq).toBeGreaterThan(first.maxSeq)
    // …and the old file's comments are gone with its cells.
    const comments = await env.AQUILLA_PG
      .prepare("SELECT COUNT(*) AS n FROM comments WHERE project_id = 'demo-john'")
      .first<{ n: number }>()
    expect(Number(comments?.n)).toBe(0)

    // Seeded as a USFM import seeds it, so it takes recordings like one.
    const file = await env.AQUILLA_PG
      .prepare("SELECT role, kind, book_code FROM files WHERE project_id = 'demo-john' AND id = 'demo-john-1'")
      .first<{ role: string; kind: string; book_code: string }>()
    expect(file).toEqual({ role: "source", kind: "usfm", book_code: "JHN" })
  })

  it("a re-seed drops a file and a rule a take added to the demo project", async () => {
    await seed()
    await env.AQUILLA_PG
      .prepare(
        `INSERT INTO files (id, project_id, name, role, kind, event_id, created_at, updated_at)
         VALUES ('psalm-23', 'demo-john', 'psalm-23.usfm', 'source', 'usfm', 'e-psalm', 1, 1)`,
      )
      .run()

    await env.AQUILLA_PG
      .prepare(`INSERT INTO project_settings (project_id, settings) VALUES ('demo-john', '{"rules":[{"id":"r1"}]}')`)
      .run()

    await seed()

    const settings = await env.AQUILLA_PG
      .prepare("SELECT COUNT(*) AS n FROM project_settings WHERE project_id = 'demo-john'")
      .first<{ n: number }>()
    expect(Number(settings?.n)).toBe(0)
    const files = await env.AQUILLA_PG
      .prepare("SELECT id FROM files WHERE project_id = 'demo-john' ORDER BY id")
      .all<{ id: string }>()
    expect(files.results.map((row) => row.id)).toEqual(["demo-john-1"])
  })

  it("a re-seed puts the teammates, lanes and projects back as seeded, for the admin videos", async () => {
    await seed()
    const db = env.AQUILLA_PG
    const lena = await db.prepare("SELECT id FROM users WHERE username = 'lena.hartmann'").first<{ id: number }>()
    // What the admin videos change: a role, a removal, a new lane, a renamed lane, a new project.
    await db.prepare("UPDATE project_members SET role_level = 500 WHERE project_id = 'demo-john' AND user_id = ?").bind(lena!.id).run()
    await db.prepare("DELETE FROM project_members WHERE project_id = 'demo-john' AND user_id = (SELECT id FROM users WHERE username = 'amara.okafor')").run()
    await db.prepare("INSERT INTO lanes (id, project_id, role, language, legacy_tag, position) VALUES ('ab12cd34', 'demo-john', 'target', 'sw', 'sw', 5)").run()
    await db
      .prepare("INSERT INTO project_member_lane_roles (project_id, user_id, lane, role_level) VALUES ('demo-john', ?, 'ab12cd34', 400)")
      .bind(lena!.id)
      .run()
    await db.prepare("UPDATE lanes SET name = 'Français (Afrique)' WHERE project_id = 'demo-john' AND legacy_tag = 'fr'").run()
    await db
      .prepare("INSERT INTO projects (id, name, org_id, created_by) SELECT 'made-in-a-take', 'Marc', org_id, created_by FROM projects WHERE id = 'demo-john'")
      .run()

    await seed()

    const members = await db
      .prepare(
        `SELECT u.username, m.role_level FROM project_members m JOIN users u ON u.id = m.user_id
         WHERE m.project_id = 'demo-john' ORDER BY u.username`,
      )
      .all<{ username: string; role_level: number }>()
    expect(members.results.map((m) => [m.username, Number(m.role_level)])).toEqual([
      ["amara.okafor", 400],
      ["demo", 700],
      ["lena.hartmann", 300],
    ])
    const lanes = await db
      .prepare("SELECT language, name FROM lanes WHERE project_id = 'demo-john' AND role = 'target'")
      .all<{ language: string; name: string | null }>()
    expect(lanes.results).toEqual([{ language: "French", name: null }])
    const made = await db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = 'made-in-a-take'").first<{ n: number }>()
    expect(Number(made?.n)).toBe(0)
    const teammate = await db
      .prepare("SELECT password_hash FROM users WHERE username = 'tomas.reyes'")
      .first<{ password_hash: string | null }>()
    expect(teammate?.password_hash).toBeNull()
  })

  it("a re-seed leaves the chain project there and unlinked, for the source-projects video", async () => {
    await seed()
    await env.AQUILLA_PG
      .prepare("UPDATE projects SET source_project_id = 'demo-john', source_link_mode = 'live', source_link_consumes = 'target' WHERE id = 'demo-jean-kreyol'")
      .run()

    await seed()

    const chain = await env.AQUILLA_PG
      .prepare("SELECT source_project_id, source_link_mode FROM projects WHERE id = 'demo-jean-kreyol'")
      .first<{ source_project_id: string | null; source_link_mode: string | null }>()
    expect(chain).toEqual({ source_project_id: null, source_link_mode: null })
  })
})
