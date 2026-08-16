// Contextual decisions (db/shared/contextual-decisions.ts, seam design §4.3).
// WHY these tests: the decision channel is only trustworthy if (1) surfacing is
// ranked by blast radius so the ONE question worth interrupting for is the one
// shown, and (2) a reason can never be silently truncated into nonsense — a
// card whose reason is cut mid-sentence is worse than no card.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import {
  raiseDecision,
  getDecision,
  listOpenDecisions,
  countOpenDecisions,
  DECISION_REASON_MAX_BYTES,
} from "../../../db/shared/contextual-decisions"

const db = env.AQUILLA_PG

function seed(overrides: Partial<Parameters<typeof raiseDecision>[1]> = {}) {
  return raiseDecision(db, {
    projectId: "proj-dec",
    runId: "run-1",
    fileId: "file-1",
    spanId: "span-1",
    cellIds: ["c1", "c2"],
    reason: "Two prior renderings of this name conflict.",
    readinessItem: "terminology",
    conceptId: "concept-1",
    blastRadius: 6,
    ...overrides,
  })
}

describe("raiseDecision", () => {
  it("persists a decision as open with no resolution", async () => {
    const d = await seed()
    expect(d.status).toBe("open")
    expect(d.resolution).toBeNull()
    expect(d.blastRadius).toBe(6)
    expect(d.cellIds).toEqual(["c1", "c2"])

    const read = await getDecision(db, d.id)
    expect(read?.id).toBe(d.id)
  })

  it("rejects an empty reason rather than surfacing a blank card", async () => {
    await expect(seed({ reason: "   " })).rejects.toThrow(/reason/i)
  })

  it("rejects an over-long reason instead of truncating it mid-sentence", async () => {
    const long = "x".repeat(DECISION_REASON_MAX_BYTES + 1)
    await expect(seed({ reason: long })).rejects.toThrow(/reason/i)
  })

  // WHY: the limit is documented as bytes, not characters. Every other test
  // reason is ASCII, so an all-ASCII test cannot distinguish a byte limit
  // from a character limit. "日" is 3 bytes in UTF-8, so 700 repeats is 700
  // characters but 2100 bytes — over the limit only if bytes are what's
  // actually being counted.
  it("rejects an over-long reason measured in bytes, not characters", async () => {
    const multiByte = "日".repeat(700)
    await expect(seed({ reason: multiByte })).rejects.toThrow(/reason/i)
  })

  // WHY: parseJson's reparse fallback makes a double-encoded column round-trip
  // correctly in JS, so only a SQL-level assertion can catch the corruption.
  it("stores cell_ids as a real jsonb array, not a double-encoded string", async () => {
    const d = await seed({ cellIds: ["c1", "c2", "c3"] })
    const row = await db
      .prepare(
        `SELECT jsonb_typeof(cell_ids) AS kind,
                jsonb_array_length(cell_ids) AS len
           FROM contextual_decisions WHERE id = ?`,
      )
      .bind(d.id)
      .first<{ kind: string; len: number }>()
    expect(row?.kind).toBe("array")
    expect(row?.len).toBe(3)
  })

  // WHY: createdAt is declared `string`, but PGlite (tests) returns
  // timestamptz as a native Date while postgres.js (production) returns a
  // string. Without conversion the declared type is false under test.
  it("returns timestamps as ISO strings, not native Date objects", async () => {
    const d = await seed()
    expect(typeof d.createdAt).toBe("string")
    expect(Number.isNaN(new Date(d.createdAt).getTime())).toBe(false)
    expect(typeof d.updatedAt).toBe("string")
    expect(Number.isNaN(new Date(d.updatedAt).getTime())).toBe(false)
  })
})

describe("listOpenDecisions", () => {
  it("ranks by blast radius, then oldest first, and honours the limit", async () => {
    const project = `proj-rank-${Date.now()}`
    const small = await seed({ projectId: project, blastRadius: 1, reason: "small" })
    const big = await seed({ projectId: project, blastRadius: 40, reason: "big" })
    const mid = await seed({ projectId: project, blastRadius: 10, reason: "mid" })

    const all = await listOpenDecisions(db, project, 10)
    expect(all.map((d) => d.id)).toEqual([big.id, mid.id, small.id])

    const capped = await listOpenDecisions(db, project, 2)
    expect(capped.map((d) => d.id)).toEqual([big.id, mid.id])

    // The held one is still open — it just isn't surfaced (§4.6).
    expect(await countOpenDecisions(db, project)).toBe(3)
  })

  // WHY: the test above never ties on blast_radius, so it can't tell the
  // `created_at ASC` tie-break apart from an unstable or reversed sort.
  it("breaks a blast-radius tie by age, oldest first", async () => {
    const project = `proj-tie-${Date.now()}`
    const older = await seed({ projectId: project, blastRadius: 5, reason: "older" })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const newer = await seed({ projectId: project, blastRadius: 5, reason: "newer" })

    const ranked = await listOpenDecisions(db, project, 10)
    expect(ranked.map((d) => d.id)).toEqual([older.id, newer.id])
  })
})
