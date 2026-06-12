// sql-guard.ts — the agent's only read path. WHY this matters: the model's
// SQL is untrusted input running against the production database; the guard
// is the difference between "read-only project Q&A" and "prompt injection
// writes to the event log". Every rejection case here is a real attack or
// real footgun shape.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { guardSql, runGuardedSql, type SqlVarContext } from "../lib/agent/sql-guard"
import { AliasMap, ROW_CAP } from "../lib/agent/compress"

const PROJECT = "11111111-1111-4111-8111-111111111111"
const FILE = "22222222-2222-4222-8222-222222222222"

const vars: SqlVarContext = { projectId: PROJECT, userId: 42 }

function guard(sql: string, v: SqlVarContext = vars, aliases = new AliasMap()) {
  return guardSql(sql, v, aliases)
}

describe("guardSql — accepts", () => {
  it("accepts a plain SELECT referencing :project and binds it", () => {
    const r = guard("SELECT cell_id, value FROM cells WHERE project_id = :project")
    expect(r).toEqual({
      ok: true,
      sql: "SELECT cell_id, value FROM cells WHERE project_id = ?",
      params: [PROJECT],
    })
  })

  it("accepts WITH … SELECT (CTEs)", () => {
    const r = guard(
      "WITH t AS (SELECT cell_id FROM cells WHERE project_id = :project) SELECT count(*) FROM t",
    )
    expect(r.ok).toBe(true)
  })

  it("binds :user and repeated :project positionally", () => {
    const r = guard(
      "SELECT * FROM project_members WHERE project_id = :project AND user_id = :user AND project_id = :project",
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.params).toEqual([PROJECT, 42, PROJECT])
  })

  it("binds aliases the run has seen (#c1) back to their UUIDs", () => {
    const aliases = new AliasMap()
    const cellId = "33333333-3333-4333-8333-333333333333"
    aliases.alias(cellId, "c")
    const r = guard(
      "SELECT value FROM cells WHERE project_id = :project AND cell_id = '#c1'",
      vars,
      aliases,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.params).toEqual([PROJECT, cellId])
  })

  it("tolerates one trailing semicolon and :: casts", () => {
    const r = guard("SELECT payload::jsonb ->> 'value' FROM events WHERE project_id = :project;")
    expect(r.ok).toBe(true)
  })
})

describe("guardSql — rejects", () => {
  const reject = (sql: string, pattern: RegExp) => {
    const r = guard(sql)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(pattern)
  }

  it("rejects UPDATE / INSERT / DELETE / DROP as the statement", () => {
    reject("UPDATE cells SET value = 'x' WHERE project_id = :project", /only a single SELECT/)
    reject("INSERT INTO events VALUES (1)", /only a single SELECT/)
    reject("DELETE FROM cells WHERE project_id = :project", /only a single SELECT/)
    reject("DROP TABLE cells", /only a single SELECT/)
  })

  it("rejects DML smuggled after a SELECT (multi-statement / ; chains)", () => {
    reject("SELECT 1 WHERE :project = :project; DELETE FROM cells", /multiple statements/)
    reject("SELECT 1 WHERE :project = :project; SELECT pg_sleep(30)", /multiple statements/)
  })

  it("rejects banned keywords anywhere, even inside a SELECT", () => {
    reject("SELECT * FROM cells WHERE project_id = :project FOR UPDATE", /UPDATE/)
    reject("SELECT x INTO newtable FROM cells WHERE project_id = :project", /INTO/)
    reject("SELECT set_config('a','b',false) WHERE :project = :project", /not allowed/)
  })

  it("cannot be fooled by keywords hidden via string-literal tricks", () => {
    // Unbalanced quote would desync literal masking — rejected outright.
    reject("SELECT 'a FROM cells WHERE project_id = :project", /unbalanced/)
    // A keyword INSIDE a balanced literal is fine (it is data, not SQL)…
    const ok = guard("SELECT 'DROP TABLE x' WHERE :project = :project")
    expect(ok.ok).toBe(true)
  })

  it("rejects comments and dollar-quoting", () => {
    reject("SELECT 1 WHERE :project = :project -- sneaky", /comments/)
    reject("SELECT 1 WHERE :project = :project /* hm */", /comments/)
    reject("SELECT $$x$$ WHERE :project = :project", /dollar/)
  })

  it("requires :project (all reads are project-scoped)", () => {
    reject("SELECT count(*) FROM cells", /:project/)
  })

  it("rejects unknown :vars and unbound focus vars", () => {
    reject("SELECT 1 WHERE project_id = :project AND a = :assignment", /unknown variable :assignment/)
    // :file referenced but no focused file in this run.
    reject("SELECT 1 WHERE project_id = :project AND file_id = :file", /:file is not bound/)
  })

  it("rejects unknown aliases", () => {
    reject("SELECT 1 WHERE project_id = :project AND cell_id = '#c9'", /unknown alias #c9/)
  })
})

describe("runGuardedSql — execution against Postgres", () => {
  async function seedCells(n: number) {
    for (let i = 0; i < n; i++) {
      await env.AQUILLA_PG.prepare(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at)
         VALUES (?, ?, ?, 'target', ?, ?, 0)`,
      )
        .bind(PROJECT, FILE, crypto.randomUUID(), `verse ${i}`, crypto.randomUUID())
        .run()
    }
  }

  it("returns rows for a valid query, capped at ROW_CAP+1 for overflow detection", async () => {
    await seedCells(ROW_CAP + 10)
    const r = await runGuardedSql(
      env.AQUILLA_PG,
      "SELECT cell_id, value FROM cells WHERE project_id = :project",
      vars,
      new AliasMap(),
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.rows).toHaveLength(ROW_CAP + 1)
  })

  it("surfaces Postgres errors as a model-readable result, not a throw", async () => {
    const r = await runGuardedSql(
      env.AQUILLA_PG,
      "SELECT no_such_column FROM cells WHERE project_id = :project",
      vars,
      new AliasMap(),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/sql error/)
  })
})
