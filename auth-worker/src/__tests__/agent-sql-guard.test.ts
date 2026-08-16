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

  // L3 escape hatch: pure catalog introspection touches no project data, so
  // the :project requirement would only weld the hatch shut (2026-06-12
  // review finding). Any project table in the query re-imposes it.
  it("allows information_schema-only queries without :project", () => {
    const r = guard(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'cells'",
    )
    expect(r.ok).toBe(true)
  })

  it("still requires :project when information_schema is joined with project tables", () => {
    const r = guard(
      "SELECT c.column_name FROM information_schema.columns c, cells x WHERE x.value = ''",
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(":project")
  })

  it("treats contextual activity as project data in catalog joins", () => {
    const r = guard(
      "SELECT e.summary FROM information_schema.tables t CROSS JOIN contextual_run_events e",
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain(":project")
  })

  it.each([
    "scene_briefs",
    "contextual_runs",
    "contextual_steering",
    "contextual_drafts",
    "contextual_project_leases",
  ])(
    "treats %s as project data in catalog joins",
    (table) => {
      const r = guard(`SELECT x.* FROM information_schema.tables t CROSS JOIN ${table} x`)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain(":project")
    },
  )
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
    const ok = guard("SELECT 'DROP TABLE x' FROM cells WHERE project_id = :project")
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

  it("rejects a non-equality use of :project as scoping (the old presence-only check let this through)", () => {
    // A query that references :project but never actually filters ON it —
    // e.g. explicitly excluding the caller's own project — used to satisfy
    // the naive "does :project appear anywhere" check.
    reject("SELECT * FROM cells WHERE project_id <> :project", /project_id = :project/)
    reject("SELECT * FROM cells WHERE project_id != :project", /project_id = :project/)
  })

  it("rejects unknown :vars and unbound focus vars", () => {
    reject("SELECT 1 WHERE project_id = :project AND a = :assignment", /unknown variable :assignment/)
    // :file referenced but no focused file in this run.
    reject("SELECT 1 WHERE project_id = :project AND file_id = :file", /:file is not bound/)
  })

  it("rejects unknown aliases", () => {
    reject("SELECT 1 WHERE project_id = :project AND cell_id = '#c9'", /unknown alias #c9/)
  })

  // AQU pen-test finding (2026-07-29): an unreferenced ("decoy") CTE is still
  // valid SQL — Postgres computes and discards it — so planting
  // `project_id = :project` in a CTE the main query never reads used to
  // satisfy the whole-string scoping check while the real SELECT returned
  // completely unscoped rows from a table with no RLS backstop (`users`,
  // including password_hash — see the next test).
  it("rejects a decoy CTE used to fake project scoping for an unrelated table", () => {
    reject(
      "WITH _x AS (SELECT project_id FROM cells WHERE project_id = :project) SELECT id, username FROM users",
      /project_id = :project/,
    )
  })

  it("still requires scoping when the decoy CTE targets a different unscoped table", () => {
    reject(
      "WITH _x AS (SELECT project_id FROM cells WHERE project_id = :project) SELECT * FROM agent_runs",
      /project_id = :project/,
    )
  })

  it("rejects password_hash through this tool regardless of scoping", () => {
    reject(
      "SELECT password_hash FROM users WHERE project_id = :project",
      /password_hash.*not allowed/,
    )
  })
})

describe("guardSql — reachable-CTE scoping still allows legitimate shapes", () => {
  it("allows a referenced CTE whose own body filters by an aliased project_id (assignments cookbook shape)", () => {
    const r = guard(
      "WITH members AS (SELECT u.id, u.username FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = :project) SELECT * FROM members",
    )
    expect(r.ok).toBe(true)
  })

  it("allows chained CTEs where only an earlier CTE carries the scoping filter", () => {
    const r = guard(
      "WITH scoped AS (SELECT cell_id FROM cells WHERE project_id = :project), counted AS (SELECT count(*) AS n FROM scoped) SELECT n FROM counted",
    )
    expect(r.ok).toBe(true)
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

  // AQU pen-test finding: the guard's :project text check can't catch every
  // cross-tenant query shape (e.g. a join that scopes one aliased table but
  // selects from an unscoped second reference to the same table). Threading
  // the caller's identity via withUser() activates the RLS backstop
  // (db/postgres/migrations/0034) as defence-in-depth regardless of query
  // shape — this asserts the identity is actually threaded, not just that
  // the query still runs.
  it("threads the caller's identity into the query (activates RLS backstop when deployed)", async () => {
    await seedCells(1)
    const r = await runGuardedSql(
      env.AQUILLA_PG,
      "SELECT current_setting('app.user_id', true) AS uid FROM cells WHERE project_id = :project LIMIT 1",
      vars,
      new AliasMap(),
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.rows[0]?.uid).toBe(String(vars.userId))
  })
})
