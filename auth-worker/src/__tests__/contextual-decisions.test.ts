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
})
