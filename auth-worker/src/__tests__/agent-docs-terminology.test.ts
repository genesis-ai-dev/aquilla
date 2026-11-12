// The terminology cookbook is SQL the agent copies verbatim. Since 2026-09-04
// the termbase is the `concepts` table (the projection of term.* events), and
// migrate-concepts.ts deletes the old `terminology` settings key once it
// copies it. A cookbook that still pointed at the key told the agent every
// migrated project had no key terms. These tests run the cookbook's own
// queries through the guard the agent's sql tool uses, so a documented query
// the guard rejects, or one that reads the wrong place, fails here.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { getCookbook } from "../lib/agent/docs"
import { runGuardedSql, type SqlVarContext } from "../lib/agent/sql-guard"
import { AliasMap } from "../lib/agent/compress"
import { AGENT_REQUIRED_ROLE } from "../lib/agent/schema-card"
import { TERM_EMIT_KINDS } from "../../../sync-worker/src/external/commands-emit-events"
import { sqlStatements } from "./helpers/cookbook-sql"

const PROJECT = "11111111-1111-4111-8111-111111111111"
const OTHER = "99999999-9999-4999-8999-999999999999"
const vars: SqlVarContext = { projectId: PROJECT, userId: 42 }

async function seedConcept(project: string, id: string, sourceTerm: string, opts: { status?: string; deletedAt?: number } = {}) {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO concepts (concept_id, project_id, source_term, renderings, status, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?)`,
  )
    .bind(id, project, sourceTerm, JSON.stringify([{ rendering: "x", status: "preferred" }]), opts.status ?? "active", opts.deletedAt ?? null)
    .run()
}

describe("terminology cookbook — reads the concepts table", () => {
  const text = getCookbook("terminology").text
  const statements = sqlStatements(text)
  const conceptQueries = statements.filter((s) => /\bFROM concepts\b/.test(s))

  it("never sends the agent to the retired settings key", () => {
    expect(text).not.toMatch(/->\s*'terminology'/)
    expect(conceptQueries.length).toBeGreaterThanOrEqual(2)
  })

  it("runs every documented query through the sql guard", async () => {
    expect(statements.length).toBeGreaterThan(0)
    for (const sql of statements) {
      const r = await runGuardedSql(env.AQUILLA_PG, sql, vars, new AliasMap())
      expect(r, sql).toMatchObject({ ok: true })
    }
  })

  it("returns this project's live active concepts and nothing from another project", async () => {
    await seedConcept(PROJECT, "k-word", "a word here")
    await seedConcept(PROJECT, "k-draft", "word draft", { status: "draft" })
    await seedConcept(PROJECT, "k-gone", "word gone", { deletedAt: 5 })
    await seedConcept(OTHER, "k-other", "other word")

    const pull = conceptQueries.find((s) => s.includes("status = 'active'"))
    expect(pull).toBeDefined()
    const r = await runGuardedSql(env.AQUILLA_PG, pull!, vars, new AliasMap())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.rows.map((row) => row.concept_id)).toEqual(["k-word"])

    const counts = conceptQueries.find((s) => s.includes("GROUP BY status"))
    expect(counts).toBeDefined()
    const c = await runGuardedSql(env.AQUILLA_PG, counts!, vars, new AliasMap())
    expect(c.ok).toBe(true)
    if (c.ok) {
      const byStatus = Object.fromEntries(c.rows.map((row) => [row.status, Number(row.n)]))
      expect(byStatus).toEqual({ active: 1, draft: 1 })
    }
  })

  it("tells the agent to write terms with term.* events, not PatchSettings", () => {
    expect(text).toContain("term.create")
    expect(text).toContain("term.update")
    expect(text).toMatch(/never with a PatchSettings op on 'terminology'/)
  })
})

// The in-app agent can stage a term only through propose_command →
// EmitEvents: emit-stage.ts rejects any kind outside AGENT_REQUIRED_ROLE, and
// that table has no term.* kinds. So a doc that names a term kind the sync-worker
// EmitEvents allowlist lacks sends the agent to a plan that prepare rejects.
describe("term.* kinds the agent docs name", () => {
  it("are all kinds that EmitEvents accepts and the raw propose tool does not", () => {
    const named = new Set<string>()
    for (const topic of ["terminology", "playbooks/project-bootstrap", "playbooks/first-cycle"]) {
      for (const m of getCookbook(topic).text.matchAll(/\bterm\.[a-z]+/g)) named.add(m[0])
    }
    expect(named.size).toBeGreaterThan(0)
    for (const kind of named) {
      expect(TERM_EMIT_KINDS.has(kind), kind).toBe(true)
      expect(AGENT_REQUIRED_ROLE[kind], kind).toBeUndefined()
    }
  })
})
