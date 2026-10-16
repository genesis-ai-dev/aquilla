// Aquilla Tools: the sync-worker turns a tool write's caller-declared
// `payload.tool_origin` into the trusted events.provenance envelope — verified
// only when that exact (project, tool, version, code hash) exists, so the
// activity log and "revert since T" can trust what they read back.

import { describe, it, expect } from "vitest"
import { stampToolProvenance, toolOriginOf } from "../events/tool-provenance"
import { makeTestDb } from "./helpers/pg-test-db"

const PROJECT = "proj-tools"
const HASH = "a".repeat(64)

async function seed(db: AquillaDb): Promise<void> {
  await db.prepare(`INSERT INTO project_tools (id, project_id, name, created_by_user_id) VALUES ('t1', ?, 'Heat map', 1)`).bind(PROJECT).run()
  await db.prepare(
    `INSERT INTO project_tool_versions (tool_id, project_id, version, source, manifest, code_hash, api_rev, origin, created_by_user_id)
     VALUES ('t1', ?, 1, '<script></script>', '{}'::jsonb, ?, 1, 'starter', 1)`,
  ).bind(PROJECT, HASH).run()
  for (const [i, id] of ["e1", "e2", "e3"].entries()) {
    await db.prepare(
      `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, kind, author, payload, client_ts, server_ts, parent_id, server_seq)
       VALUES (?, 1, ?, 'f', 'c', 'target.cell.commit', 'alice', '{}', 1, 1, null, ?)`,
    ).bind(id, PROJECT, i + 1).run()
  }
}

describe("tool provenance stamp", () => {
  it("stamps verified for a known version, unverified for a forged hash, nothing for untagged writes", async () => {
    const t = await makeTestDb()
    try {
      await seed(t.db)
      const tag = (codeHash: string) => ({ value: "x", tool_origin: { origin: "tool", toolId: "t1", version: 1, codeHash } })
      const n = await stampToolProvenance(t.db, [
        { id: "e1", projectId: PROJECT, author: "alice", payload: tag(HASH) },
        { id: "e2", projectId: PROJECT, author: "alice", payload: tag("b".repeat(64)) },
        { id: "e3", projectId: PROJECT, author: "alice", payload: { value: "human" } },
      ])
      expect(n).toBe(2)
      const rows = await t.pg.query<{ id: string; provenance: Record<string, unknown> | null }>(
        "SELECT id, provenance FROM events ORDER BY id",
      )
      const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.provenance]))
      expect(byId.e1).toMatchObject({ origin: "tool", toolId: "t1", version: 1, verified: true, human_authority: { user_id: "alice" } })
      expect(byId.e2).toMatchObject({ origin: "tool", verified: false })
      expect(byId.e3).toBeNull()
    } finally {
      await t.close?.()
    }
  })

  it("ignores malformed tags", () => {
    expect(toolOriginOf({ tool_origin: { origin: "tool", toolId: "t1", version: "1", codeHash: HASH } })).toBeNull()
    expect(toolOriginOf({ tool_origin: { origin: "agent", toolId: "t1", version: 1, codeHash: HASH } })).toBeNull()
  })
})
