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
  answerDecision,
  dismissDecision,
  assignDecision,
  supersedeDecisions,
  expireDecisionsOlderThan,
} from "../../../db/shared/contextual-decisions"
import {
  createRun,
  getRun,
  claimStrandedRuns,
  blockRunOnDecision,
  unblockRun,
} from "../../../db/shared/contextual-runs"

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

  // WHY: documents the intended stored shape — a real jsonb array, not a
  // double-encoded string. It does NOT regression-guard that under this
  // harness: PGlite's ?::jsonb binding doesn't reproduce postgres.js's
  // client-side double-serialization, so a pre-stringified value would
  // still parse correctly here and this test would still pass. The actual
  // guarantee comes from binding the plain array/object directly, per the
  // convention documented at contextual-runs.ts:718-721.
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

describe("decision transitions", () => {
  it("answering closes it and records who answered", async () => {
    const d = await seed()
    const t = await answerDecision(db, d.id, "Use 'council'.", 42)
    expect(t.status).toBe("ok")
    if (t.status !== "ok") throw new Error("unreachable")
    expect(t.decision.status).toBe("resolved")
    expect(t.decision.resolution).toEqual({
      kind: "answered",
      answer: "Use 'council'.",
      byUserId: 42,
    })
    expect(t.decision.resolvedAt).not.toBeNull()
  })

  it("refuses to answer an already-closed decision instead of clobbering it", async () => {
    const d = await seed()
    await answerDecision(db, d.id, "first", 1)
    const second = await answerDecision(db, d.id, "second", 2)
    expect(second.status).toBe("invalid_state")

    const read = await getDecision(db, d.id)
    expect(read?.resolution).toEqual({ kind: "answered", answer: "first", byUserId: 1 })
  })

  it("reports not_found for an unknown id", async () => {
    expect((await answerDecision(db, "nope", "x", 1)).status).toBe("not_found")
  })

  // The invariant the whole design rests on: routing must NOT close anything,
  // or a queue of unanswered questions reports as handled work.
  it("assigning leaves the decision open so anyone can still answer it", async () => {
    const project = `proj-assign-${Date.now()}`
    const d = await seed({ projectId: project })
    const t = await assignDecision(db, d.id, { userId: 7 })
    expect(t.status).toBe("ok")
    if (t.status !== "ok") throw new Error("unreachable")
    expect(t.decision.status).toBe("open")
    expect(t.decision.assignedUserId).toBe(7)

    // Still surfaced, still countable, and answerable by someone else.
    expect(await countOpenDecisions(db, project)).toBe(1)
    const answered = await answerDecision(db, d.id, "settled", 99)
    expect(answered.status).toBe("ok")
  })

  it("supersedes only open decisions and reports how many it closed", async () => {
    const open = await seed()
    const closed = await seed()
    await dismissDecision(db, closed.id)

    const n = await supersedeDecisions(db, [open.id, closed.id])
    expect(n).toBe(1)
    expect((await getDecision(db, open.id))?.status).toBe("superseded")
    expect((await getDecision(db, closed.id))?.status).toBe("dismissed")
  })

  it("expires only decisions older than the cutoff", async () => {
    const project = `proj-exp-${Date.now()}`
    const fresh = await seed({ projectId: project })
    const past = new Date(Date.now() - 60_000).toISOString()
    expect(await expireDecisionsOlderThan(db, project, past)).toBe(0)

    const future = new Date(Date.now() + 60_000).toISOString()
    expect(await expireDecisionsOlderThan(db, project, future)).toBe(1)
    expect((await getDecision(db, fresh.id))?.status).toBe("expired")
  })
})

async function newRun(projectId: string, fileId = "f1") {
  const created = await createRun(db, { projectId, fileId, targetLang: "" })
  if (created.status !== "ok") throw new Error(`createRun: ${created.status}`)
  return created.run
}

describe("waiting run status", () => {
  it("blocks a running run on a decision and unblocks it again", async () => {
    const project = `proj-wait-${Date.now()}`
    const run = await newRun(project)
    const d = await seed({ projectId: project, runId: run.id })

    const blocked = await blockRunOnDecision(db, run.id, d.id)
    expect(blocked.status).toBe("ok")
    expect((await getRun(db, run.id))?.status).toBe("waiting")

    const unblocked = await unblockRun(db, run.id)
    expect(unblocked.status).toBe("ok")
    expect((await getRun(db, run.id))?.status).toBe("running")
  })

  // THE regression test for §4.5. A waiting run adopted by the sweeper gets
  // flipped to running and re-ticked forever — burning budget while the human
  // it is waiting for never gets asked again. The predicate must name statuses
  // explicitly and must never include 'waiting'.
  // A waiting run holds its lane, so starting another run on the same file
  // must report `active_exists` — NOT surface a raw unique-violation error
  // from Postgres. See Step 3 item 6.
  it("reports active_exists rather than throwing when a waiting run holds the lane", async () => {
    const project = `proj-lane-${Date.now()}`
    const run = await newRun(project)
    const d = await seed({ projectId: project, runId: run.id })
    await blockRunOnDecision(db, run.id, d.id)

    const second = await createRun(db, { projectId: project, fileId: "f1", targetLang: "" })
    expect(second.status).toBe("active_exists")
    if (second.status !== "active_exists") throw new Error("unreachable")
    expect(second.runId).toBe(run.id)
  })

  it("is never adopted by the stranded-run sweeper", async () => {
    const project = `proj-sweep-${Date.now()}`
    const run = await newRun(project)
    const d = await seed({ projectId: project, runId: run.id })
    await blockRunOnDecision(db, run.id, d.id)

    // Backdate well past any staleness threshold so the ONLY thing keeping it
    // out of the sweep is its status.
    await db
      .prepare(`UPDATE contextual_runs SET updated_at = now() - interval '1 day' WHERE id = ?`)
      .bind(run.id)
      .run()

    const claimed = await claimStrandedRuns(db, 50)
    expect(claimed.map((r) => r.id)).not.toContain(run.id)
    expect((await getRun(db, run.id))?.status).toBe("waiting")
  })
})
