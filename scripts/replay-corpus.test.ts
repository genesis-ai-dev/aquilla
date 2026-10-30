import { describe, expect, it } from "vitest"
import {
  buildSyntheticCorpus,
  corpusBytes,
  exportProject,
  manifestEntry,
  serializeRow,
  sha256Hex,
  upsertEntry,
} from "./replay-corpus.mjs"

// The gate compares a golden against a corpus pinned by sha256, so the
// export has to be byte-stable and the manifest has to describe exactly the
// bytes written. These tests pin that contract, not the database.

describe("serializeRow", () => {
  it("turns driver bigints and dates into JSON the harness can bind back", () => {
    const row = serializeRow({ server_seq: 42n, server_ts: "1700000000000", created_at: new Date("2026-01-02T03:04:05.000Z"), payload: "{}", provenance: { origin: "agent" }, name: "12345" })
    expect(row).toEqual({
      server_seq: 42,
      server_ts: 1700000000000,
      created_at: "2026-01-02T03:04:05.000Z",
      payload: "{}",
      provenance: { origin: "agent" },
      name: "12345",
    })
  })
})

describe("corpusBytes + manifestEntry", () => {
  it("is byte-stable and the manifest pins exactly those bytes", () => {
    const { rows } = buildSyntheticCorpus()
    const a = corpusBytes(rows)
    const b = corpusBytes(buildSyntheticCorpus().rows)
    expect(a).toBe(b)
    const entry = manifestEntry({ slug: "s", source: "synthetic", file: "s.json", bytes: a, events: rows.events, capturedAt: "2026-10-30T00:00:00.000Z" })
    expect(entry.sha256).toBe(sha256Hex(a))
    expect(entry).not.toHaveProperty("projectId")
    expect(entry.events).toBe(rows.events.length)
    expect(entry.maxSeq).toBe(rows.events.length)
  })

  it("writes every input table even when a capture has no rows for it", () => {
    const parsed = JSON.parse(corpusBytes({ events: [] }))
    expect(Object.keys(parsed)).toEqual(["lanes", "project_seq_counters", "chain_claims", "events"])
  })
})

describe("upsertEntry", () => {
  it("replaces an entry by slug and keeps the list sorted", () => {
    const base = { format: 1 as const, projects: [{ slug: "b", source: "r2" as const, file: "b.json", sha256: "old", events: 1, maxSeq: 1, capturedAt: "" }] }
    const next = upsertEntry(base, { ...base.projects[0], sha256: "new" })
    expect(next.projects).toHaveLength(1)
    expect(next.projects[0].sha256).toBe("new")
    const added = upsertEntry(next, { ...base.projects[0], slug: "a" })
    expect(added.projects.map((p) => p.slug)).toEqual(["a", "b"])
  })
})

describe("buildSyntheticCorpus", () => {
  it("carries a chain claim that names the higher-seq sibling, so replay order alone cannot pass", () => {
    const { rows } = buildSyntheticCorpus()
    const claim = rows.chain_claims[0]
    // Default target lane: the claim key is the bare parent id (chain-claims.ts).
    const siblings = rows.events.filter((e) => e.cell_id === claim.cell_id && e.parent_id === claim.parent_key)
    expect(siblings).toHaveLength(2)
    const winner = siblings.find((e) => e.id === claim.event_id)!
    const loser = siblings.find((e) => e.id !== claim.event_id)!
    expect(Number(winner.server_seq)).toBeGreaterThan(Number(loser.server_seq))
  })
})

describe("exportProject", () => {
  it("reads the rebuild's input tables scoped to the project, events in seq order", async () => {
    const queries: string[] = []
    const sql = {
      async unsafe(query: string, params?: unknown[]) {
        queries.push(query)
        expect(params).toEqual(["p1"])
        return query.includes("FROM events") ? [{ id: "e", server_seq: 1n }] : []
      },
    }
    const rows = await exportProject(sql, "p1")
    expect(rows.events).toEqual([{ id: "e", server_seq: 1 }])
    expect(queries.some((q) => q.includes("FROM lanes"))).toBe(true)
    expect(queries.some((q) => q.includes("FROM chain_claims"))).toBe(true)
    expect(queries.find((q) => q.includes("FROM events"))).toContain("ORDER BY server_seq")
  })
})
