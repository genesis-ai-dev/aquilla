// sql-guard.ts — the agent's only read path. WHY this matters: the model's
// SQL is untrusted input running against the production database; the guard
// is the difference between "read-only project Q&A" and "prompt injection
// writes to the event log". Every rejection case here is a real attack or
// real footgun shape.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { guardSql, runGuardedSql, READABLE_TABLES, type SqlVarContext } from "../lib/agent/sql-guard"
import { AliasMap, ROW_CAP } from "../lib/agent/compress"

const PROJECT = "11111111-1111-4111-8111-111111111111"
const FILE = "22222222-2222-4222-8222-222222222222"

const vars: SqlVarContext = { projectId: PROJECT, userId: 42 }

function guard(sql: string, v: SqlVarContext = vars, aliases = new AliasMap()) {
  return guardSql(sql, v, aliases)
}

describe("guardSql — accepts", () => {
  // Since 2026-09-28 every readable-table reference is rewritten into a
  // project-scoped derived table (READABLE_TABLES), so the emitted statement
  // carries one extra bound :project per relation — that rewrite, not the
  // caller's own predicate, is what keeps the read inside one project.
  it("accepts a plain SELECT referencing :project, scoping the relation and binding it", () => {
    const r = guard("SELECT cell_id, value FROM cells WHERE project_id = :project")
    expect(r).toEqual({
      ok: true,
      sql:
        "SELECT cell_id, value FROM (SELECT * FROM cells WHERE project_id = ?) cells " +
        "WHERE project_id = ?",
      params: [PROJECT, PROJECT],
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
    // The leading PROJECT is the scoping rewrite's own bind.
    if (r.ok) expect(r.params).toEqual([PROJECT, PROJECT, 42, PROJECT])
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
    if (r.ok) expect(r.params).toEqual([PROJECT, PROJECT, cellId])
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
    "concepts",
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
    // `users` is now double-protected: BANNED_TABLES rejects it outright
    // (2026-09-23 fix, below), which fires before the CTE-reachability check
    // this test was originally written to exercise would even run. The next
    // test covers the same decoy-CTE shape against a table that isn't banned
    // outright (`agent_runs`), so the scoping-bypass coverage isn't lost.
    reject(
      "WITH _x AS (SELECT project_id FROM cells WHERE project_id = :project) SELECT id, username FROM users",
      /table "users" is not allowed/,
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

  // AQU pen-test finding, 2026-09-23: `users` has no project_id column and no
  // RLS backstop (db/postgres/migrations/0034 doesn't cover it), so the
  // whole-query ":project appears somewhere" check did nothing to scope a
  // join against it — this exact query used to pass guardSql and, run for
  // real, returned every account's email on the platform, not just members
  // of the caller's project. Verified against the pre-fix guard before this
  // test was written.
  it("rejects the users table outright, even correctly scoped elsewhere in the query", () => {
    reject(
      "SELECT c.cell_id, u.email, u.username FROM cells c CROSS JOIN users u WHERE c.project_id = :project",
      /table "users" is not allowed/,
    )
  })

  it("rejects users referenced via a correctly-scoped join, not just a cross join", () => {
    reject(
      "SELECT u.email FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = :project",
      /table "users" is not allowed/,
    )
  })
})

describe("guardSql — reachable-CTE scoping still allows legitimate shapes", () => {
  it("allows a referenced CTE whose own body filters by an aliased project_id (assignments cookbook shape)", () => {
    const r = guard(
      "WITH members AS (SELECT pm.user_id, pm.role_level FROM project_members pm WHERE pm.project_id = :project) SELECT * FROM members",
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

  // AQU pen-test finding, 2026-09-23: vars.projectId is embedded directly
  // into `SET LOCAL app.project_id = '<id>'` (SET LOCAL can't take a bind
  // parameter). In practice it only ever reaches here already validated by
  // resolveProjectRole()'s parameterized lookup, but this function
  // re-validates rather than trusts it — the same GUC-injection shape
  // PostgresDb.withUser() already guards for app.user_id.
  it("rejects a malformed projectId rather than interpolate it unvalidated", async () => {
    const r = await runGuardedSql(
      env.AQUILLA_PG,
      "SELECT cell_id FROM cells WHERE project_id = :project",
      { ...vars, projectId: "not-a-uuid'; --" },
      new AliasMap(),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/projectId/)
  })
})

// ─── AQU pen-test finding, 2026-09-28 ────────────────────────────────────────
// Before this change the tool was a blocklist over the whole database, and the
// only scoping requirement was that `project_id = :project` appear SOMEWHERE
// in the reachable query text. One correctly-scoped table therefore admitted
// an arbitrary second, unscoped one. Each query in the first block below was
// run against the pre-fix guardSql() and returned ok:true; the worst of them
// returned every live invite token on the platform (project_invites stores
// them in plaintext — OPS-26 — and each is a working project-access
// credential at a stated role_level). `… OR 1 = 1` and `NOT (…)` neutralised
// the scoping predicate outright, on every table including the readable ones.
//
// The old comments delegated that gap to the RLS backstop; only 21 of the
// schema's 55 project-scoped tables have an RLS policy and none of the tables
// below is among them, so it never covered it. Scoping is now structural: the
// allowlist here, plus a rewrite of every reference into a project-scoped
// derived table.
describe("guardSql — relation allowlist (2026-09-28)", () => {
  const reject = (sql: string, pattern: RegExp) => {
    const r = guard(sql)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(pattern)
  }

  it.each([
    // The reproduced exploit: every live invite token on the platform.
    ["project_invites", "SELECT i.token, i.role_level, i.email FROM cells c CROSS JOIN project_invites i WHERE c.project_id = :project"],
    // Deep-link token + the scrypt PIN hash guarding it.
    ["project_access_links", "SELECT l.token, l.pin_hash FROM cells c CROSS JOIN project_access_links l WHERE c.project_id = :project"],
    // The settings blob holds user-supplied vendor API keys, which
    // routes/org-settings.ts redacts on read and raw SQL would not.
    ["org_settings", "SELECT o.settings FROM cells c CROSS JOIN org_settings o WHERE c.project_id = :project"],
    ["agent_memories", "SELECT m.content FROM cells c CROSS JOIN agent_memories m WHERE c.project_id = :project"],
    ["api_credentials", "SELECT a.token_hash FROM cells c CROSS JOIN api_credentials a WHERE c.project_id = :project"],
    ["knowledge_docs", "SELECT k.extracted_text FROM cells c CROSS JOIN knowledge_docs k WHERE c.project_id = :project"],
    ["project_briefs", "SELECT b.content FROM cells c CROSS JOIN project_briefs b WHERE c.project_id = :project"],
    ["agent_runs", "SELECT r.* FROM cells c CROSS JOIN agent_runs r WHERE c.project_id = :project"],
    ["organizations", "SELECT o.* FROM cells c CROSS JOIN organizations o WHERE c.project_id = :project"],
    ["password_reset_tokens", "SELECT t.* FROM cells c CROSS JOIN password_reset_tokens t WHERE c.project_id = :project"],
  ])("rejects %s even when another table in the query is correctly scoped", (table, sql) => {
    reject(sql, new RegExp(`table "${table}" is not readable`))
  })

  it("rejects a schema-qualified name rather than resolving it", () => {
    reject("SELECT * FROM public.cells WHERE project_id = :project", /public\.cells" is not readable/)
    reject(
      "SELECT t.* FROM pg_catalog.pg_tables t CROSS JOIN cells c WHERE c.project_id = :project",
      /pg_catalog\.pg_tables" is not readable/,
    )
  })

  it("rejects a set-returning function in a relation position", () => {
    reject(
      "SELECT g FROM generate_series(1, 3) g, cells c WHERE c.project_id = :project",
      /set-returning functions are not allowed/,
    )
  })

  it("rejects a CTE that shadows a readable table name", () => {
    // Otherwise the rewrite would wrap the CTE's own name and the inner
    // reference would resolve back to the CTE.
    reject(
      "WITH cells AS (SELECT 1 AS x) SELECT * FROM cells WHERE project_id = :project",
      /shadows a table of the same name/,
    )
  })

  it("rejects FROM-operand function syntax instead of mis-parsing it as a relation", () => {
    // `EXTRACT(epoch FROM x)` puts an expression where scanRelations() expects
    // a table, so it is rejected by name with the ordinary-call alternative.
    reject(
      "SELECT extract(epoch FROM to_timestamp(server_ts / 1000)) FROM events WHERE project_id = :project",
      /EXTRACT.*date_part/,
    )
  })

  it.each([
    ["plain single table", "SELECT cell_id, value FROM cells WHERE project_id = :project"],
    [
      "drafting cookbook — source/target self-join",
      "SELECT c.cell_id, s.canonical_ref, s.value AS source_text FROM cells c JOIN cells s" +
        " ON s.project_id = c.project_id AND s.cell_id = c.cell_id AND s.side = 'source'" +
        " WHERE c.project_id = :project AND c.side = 'target' AND c.value = '' ORDER BY s.canonical_ref LIMIT 40",
    ],
    [
      "checking cookbook — aggregate with FILTER",
      "SELECT count(*) FILTER (WHERE value <> '') AS filled, count(*) FILTER (WHERE validated = 1) AS validated" +
        " FROM cells WHERE project_id = :project AND side = 'target'",
    ],
    [
      "terminology cookbook — morphology join",
      "SELECT m.surface, m.lemma, c.canonical_ref FROM cell_word_morph m JOIN cells c" +
        " ON c.project_id = m.project_id AND c.file_id = m.file_id AND c.cell_id = m.cell_id AND c.side = 'source'" +
        " WHERE m.project_id = :project AND m.lemma = 'x' LIMIT 50",
    ],
    [
      "terminology cookbook — jsonb over the settings blob",
      "SELECT jsonb_array_elements(settings::jsonb -> 'terminology' -> 'concepts') AS concept" +
        " FROM project_settings WHERE project_id = :project LIMIT 50",
    ],
    [
      "validation cookbook — correlated subquery",
      "SELECT c.cell_id, (SELECT count(*) FROM cell_validators v WHERE v.project_id = c.project_id" +
        " AND v.cell_id = c.cell_id) AS n FROM cells c WHERE c.project_id = :project",
    ],
    [
      "assignments cookbook — assignment_cells through its assignment",
      "SELECT a.scope_label, count(ac.cell_id) AS n FROM assignments a" +
        " JOIN assignment_cells ac ON ac.assignment_id = a.assignment_id" +
        " WHERE a.project_id = :project GROUP BY a.scope_label",
    ],
    ["comma-separated FROM list", "SELECT c.value, f.name FROM cells c, files f WHERE c.project_id = :project AND f.id = c.file_id"],
    [
      "LEFT JOIN with ORDER BY / LIMIT",
      "SELECT c.cell_id FROM cells c LEFT JOIN comments m ON m.cell_id = c.cell_id AND m.project_id = c.project_id" +
        " WHERE c.project_id = :project ORDER BY c.cell_id LIMIT 5",
    ],
    ["derived table in FROM", "SELECT t.n FROM (SELECT count(*) AS n FROM cells WHERE project_id = :project) t"],
    ["catalog introspection", "SELECT column_name FROM information_schema.columns WHERE table_name = 'cells'"],
  ])("still accepts the documented shape: %s", (_name, sql) => {
    const r = guard(sql, { ...vars, fileId: FILE })
    expect(r.ok).toBe(true)
  })

  it("scopes every relation reference, not just the one the caller filtered", () => {
    const r = guard("SELECT c2.value FROM cells c1 JOIN cells c2 ON 1 = 1 WHERE c1.project_id = :project")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Both aliases become project-scoped derived tables, so the unfiltered
    // `c2` can no longer reach another project's rows.
    expect(r.sql).toBe(
      "SELECT c2.value FROM (SELECT * FROM cells WHERE project_id = ?) c1 " +
        "JOIN (SELECT * FROM cells WHERE project_id = ?) c2 ON 1 = 1 WHERE c1.project_id = ?",
    )
    expect(r.params).toEqual([PROJECT, PROJECT, PROJECT])
  })

  it.each([
    ["OR that neutralises the predicate", "SELECT cell_id FROM cells WHERE project_id = :project OR 1 = 1"],
    ["NOT around the predicate", "SELECT cell_id FROM cells WHERE NOT (project_id = :project)"],
  ])("survives a predicate the caller sabotaged: %s", (_name, sql) => {
    // These satisfy PROJECT_EQ_RE and always will — that check reads text. The
    // rewrite is what makes them harmless: the relation itself is scoped, so
    // the sabotaged predicate can only ever narrow the caller's own project.
    const r = guard(sql)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.sql).toContain("(SELECT * FROM cells WHERE project_id = ?) cells")
  })

  it("scopes assignment_cells through the assignment that owns the row", () => {
    // The one readable table with no project_id column of its own.
    const r = guard("SELECT ac.* FROM cells c CROSS JOIN assignment_cells ac WHERE c.project_id = :project")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.sql).toContain("JOIN assignments _aq_a ON _aq_a.assignment_id = _aq_ac.assignment_id AND _aq_a.project_id = ?")
  })
})

// Drift guards. The allowlist is only as good as its agreement with the real
// schema and with what the model is told it may read; both drift silently
// otherwise (the reason the list this replaced went stale for two months).
describe("READABLE_TABLES — drift against the schema and the prompt", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
  const schemaSql = readFileSync(path.join(repoRoot, "db/postgres/schema.sql"), "utf8")
  const schemaCard = readFileSync(path.join(repoRoot, "auth-worker/src/lib/agent/schema-card.ts"), "utf8")

  /** Top-level column names of one CREATE TABLE block in schema.sql. */
  function columnsOf(table: string): string[] {
    const start = new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table}\\s*\\(`, "i").exec(schemaSql)
    expect(start, `table ${table} is not in db/postgres/schema.sql`).not.toBeNull()
    const open = start!.index + start![0].length - 1
    let depth = 0
    let close = -1
    for (let i = open; i < schemaSql.length; i++) {
      if (schemaSql[i] === "(") depth++
      else if (schemaSql[i] === ")" && --depth === 0) {
        close = i
        break
      }
    }
    expect(close, `unbalanced CREATE TABLE ${table}`).toBeGreaterThan(open)
    const body = schemaSql.slice(open + 1, close)
    return [...body.matchAll(/^\s{2,}([a-z_][a-z0-9_]*)\s/gim)]
      .map((m) => m[1].toLowerCase())
      .filter((name) => !["primary", "unique", "constraint", "check", "foreign"].includes(name))
  }

  it.each(Object.keys(READABLE_TABLES))("%s exists in the live schema", (table) => {
    expect(columnsOf(table).length).toBeGreaterThan(0)
  })

  it.each(Object.keys(READABLE_TABLES).filter((t) => t !== "assignment_cells"))(
    "%s carries project_id and its scoping template filters on it",
    (table) => {
      expect(columnsOf(table)).toContain("project_id")
      expect(READABLE_TABLES[table]).toContain("WHERE project_id = :project")
    },
  )

  it("scopes assignment_cells through assignments, since it has no project_id of its own", () => {
    expect(columnsOf("assignment_cells")).not.toContain("project_id")
    expect(READABLE_TABLES.assignment_cells).toContain("_aq_a.project_id = :project")
  })

  it.each(Object.keys(READABLE_TABLES))("%s is documented to the model in the schema card", (table) => {
    // A readable table the prompt never mentions is a table the model can only
    // find by accident; a documented table that isn't readable is a dead end.
    expect(schemaCard).toContain(table)
  })
})

describe("runGuardedSql — cross-project isolation (2026-09-28)", () => {
  const OTHER = "99999999-9999-4999-8999-999999999999"

  async function seedTwoProjects() {
    for (const project of [PROJECT, OTHER]) {
      const cellId = crypto.randomUUID()
      await env.AQUILLA_PG.prepare(
        `INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at)
         VALUES (?, ?, ?, 'target', ?, ?, 0)`,
      ).bind(project, FILE, cellId, `text for ${project}`, crypto.randomUUID()).run()
      await env.AQUILLA_PG.prepare(
        `INSERT INTO cell_backtranslations
           (project_id, file_id, cell_id, target_event_id, bt_text, author, event_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'someone', ?, 0)`,
      ).bind(project, FILE, cellId, crypto.randomUUID(), `bt for ${project}`, crypto.randomUUID()).run()
      await env.AQUILLA_PG.prepare(
        `INSERT INTO assignments
           (assignment_id, project_id, assignee_user_id, scope_kind, scope_label, lane_id, created_by, created_at)
         VALUES (?, ?, 7, 'books', ?, '', 1, 0)`,
      ).bind(crypto.randomUUID(), project, `scope for ${project}`).run()
    }
  }

  // The shape that made this a finding: one scoped table dragging an unscoped
  // one along. Asserted against real rows from two projects, not just against
  // the guard's verdict.
  it("returns no other project's back-translations from an unscoped join", async () => {
    await seedTwoProjects()
    const r = await runGuardedSql(
      env.AQUILLA_PG,
      "SELECT b.project_id, b.bt_text FROM cells c CROSS JOIN cell_backtranslations b WHERE c.project_id = :project",
      vars,
      new AliasMap(),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rows.length).toBeGreaterThan(0)
    expect([...new Set(r.rows.map((row) => row.project_id))]).toEqual([PROJECT])
  })

  it("returns no other project's assignments from an unscoped join", async () => {
    await seedTwoProjects()
    const r = await runGuardedSql(
      env.AQUILLA_PG,
      "SELECT a.project_id, a.scope_label FROM cells c CROSS JOIN assignments a WHERE c.project_id = :project",
      vars,
      new AliasMap(),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rows.length).toBeGreaterThan(0)
    expect([...new Set(r.rows.map((row) => row.project_id))]).toEqual([PROJECT])
  })

  // concepts (the termbase) joined the allowlist so the terminology cookbook
  // can read it (AQU-1723). It must be scoped like every other readable table.
  it("returns no other project's concepts from an unscoped join", async () => {
    await seedTwoProjects()
    for (const project of [PROJECT, OTHER]) {
      await env.AQUILLA_PG.prepare(
        `INSERT INTO concepts (concept_id, project_id, source_term, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 0, 0)`,
      ).bind(crypto.randomUUID(), project, `term for ${project}`).run()
    }
    const r = await runGuardedSql(
      env.AQUILLA_PG,
      "SELECT k.project_id, k.source_term FROM cells c CROSS JOIN concepts k WHERE c.project_id = :project",
      vars,
      new AliasMap(),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rows.length).toBeGreaterThan(0)
    expect([...new Set(r.rows.map((row) => row.project_id))]).toEqual([PROJECT])
  })

  it("returns no other project's cells from a self-join whose second alias is unfiltered", async () => {
    await seedTwoProjects()
    const r = await runGuardedSql(
      env.AQUILLA_PG,
      "SELECT c2.project_id, c2.value FROM cells c1 JOIN cells c2 ON 1 = 1 WHERE c1.project_id = :project",
      vars,
      new AliasMap(),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rows.length).toBeGreaterThan(0)
    expect([...new Set(r.rows.map((row) => row.project_id))]).toEqual([PROJECT])
  })

  it("returns nothing at all when the caller sabotages its own predicate with OR", async () => {
    await seedTwoProjects()
    const r = await runGuardedSql(
      env.AQUILLA_PG,
      "SELECT project_id, value FROM cells WHERE project_id = :project OR 1 = 1",
      vars,
      new AliasMap(),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect([...new Set(r.rows.map((row) => row.project_id))]).toEqual([PROJECT])
  })

  it("still executes the documented assignment_cells join", async () => {
    await seedTwoProjects()
    const r = await runGuardedSql(
      env.AQUILLA_PG,
      "SELECT a.scope_label, count(ac.cell_id) AS n FROM assignments a" +
        " LEFT JOIN assignment_cells ac ON ac.assignment_id = a.assignment_id" +
        " WHERE a.project_id = :project GROUP BY a.scope_label",
      vars,
      new AliasMap(),
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.rows.map((row) => row.scope_label)).toEqual([`scope for ${PROJECT}`])
  })
})

describe("guardSql — pen-test 2026-09-30 literal-desync and xml-function bypasses", () => {
  it("rejects E'…' escape strings that desync the literal mask", () => {
    const r = guard(
      "SELECT E'\\'' || (SELECT max(email) FROM users) || E'\\'' FROM cells WHERE project_id = :project",
    )
    expect(r.ok).toBe(false)
  })
  it("rejects U&'…' literals", () => {
    expect(guard("SELECT U&'a' FROM cells WHERE project_id = :project").ok).toBe(false)
  })
  it("rejects ts_stat / advisory locks / server-FS probes", () => {
    for (const expr of [
      "(ts_stat('select value_tsv from cells')).word",
      "pg_advisory_lock(1)::text",
      "pg_advisory_xact_lock(1)::text",
      "(pg_stat_file('/etc/passwd')).size",
    ]) {
      const r = guard(`SELECT ${expr} FROM cells WHERE project_id = :project`)
      expect(r.ok).toBe(false)
    }
  })

  it("rejects query_to_xml (runs an unscoped query from a string)", () => {
    const r = guard("SELECT query_to_xml('select * from users', true, false, '') FROM cells WHERE project_id = :project")
    expect(r.ok).toBe(false)
  })
  it("still accepts plain literals ending in e", () => {
    expect(guard("SELECT 'tree' FROM cells WHERE project_id = :project").ok).toBe(true)
  })
})
