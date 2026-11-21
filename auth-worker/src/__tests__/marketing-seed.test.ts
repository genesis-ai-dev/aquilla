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
  })
})
