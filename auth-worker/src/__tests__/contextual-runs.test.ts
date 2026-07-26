// Contextual run store (db/shared/contextual-runs.ts, design §8 slice D1).
// WHY these tests: the run engine's correctness rests on (1) exactly one
// active run per (project, file, lane), (2) status transitions that CANNOT be
// won by both sides of a race (guarded UPDATEs), and (3) staged drafts whose
// partial-UNIQUE "one live proposal per cell" invariant survives re-proposes.
// Each test targets a specific way one of those guarantees could fail open.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import {
  createRun,
  getRun,
  listRuns,
  getActiveRun,
  requestPause,
  confirmPause,
  resumeRun,
  terminateRun,
  parkRun,
  failRun,
  setSpanCursor,
  recordSpanOutcome,
  appendSteering,
  readUnconsumedSteering,
  markSteeringConsumed,
  insertDrafts,
  listDrafts,
  reviewDraft,
  countDrafts,
  STEERING_MAX_BYTES,
  type SpanCursor,
} from "../../../db/shared/contextual-runs"

const db = env.AQUILLA_PG
const PROJECT = "proj-ctx"
const FILE = "file-mrk"

const seed = (n: number) => ({
  id: `${FILE}#s${n}`,
  fileId: FILE,
  anchorCellId: `c${n}`,
  startCellId: `c${n}`,
  endCellId: `c${n + 1}`,
  seedSource: "chunk",
})

async function newRun(over: { fileId?: string; targetLang?: string } = {}) {
  const r = await createRun(db, {
    projectId: PROJECT,
    fileId: over.fileId ?? FILE,
    targetLang: over.targetLang ?? "",
    initiatedBy: "tester",
    roleSnapshot: { userId: 1, username: "tester", level: 400 },
  })
  expect(r.status).toBe("ok")
  if (r.status !== "ok") throw new Error("unreachable")
  return r.run
}

describe("run creation — one active run per (project, file, lane)", () => {
  it("refuses a second active run; a different lane or a terminated run frees the slot", async () => {
    const run = await newRun()
    expect(run.status).toBe("running")

    // Same lane → refused, pointing at the existing run.
    const dup = await createRun(db, { projectId: PROJECT, fileId: FILE })
    expect(dup).toEqual({ status: "active_exists", runId: run.id })

    // Refusal covers EVERY active status, not just running.
    await requestPause(db, run.id)
    expect((await createRun(db, { projectId: PROJECT, fileId: FILE })).status).toBe("active_exists")

    // A different lane is a different slot.
    const otherLane = await createRun(db, { projectId: PROJECT, fileId: FILE, targetLang: "fr" })
    expect(otherLane.status).toBe("ok")

    // Terminating the first frees its lane.
    await terminateRun(db, run.id)
    const again = await createRun(db, { projectId: PROJECT, fileId: FILE })
    expect(again.status).toBe("ok")
  })

  it("getActiveRun / listRuns surface the right rows", async () => {
    const run = await newRun()
    expect((await getActiveRun(db, PROJECT, FILE))?.id).toBe(run.id)
    expect(await getActiveRun(db, PROJECT, "other-file")).toBeNull()
    await terminateRun(db, run.id)
    expect(await getActiveRun(db, PROJECT, FILE)).toBeNull()
    // Terminated runs still list (history).
    expect((await listRuns(db, PROJECT, FILE)).map((r) => r.id)).toContain(run.id)
  })
})

describe("guarded transitions", () => {
  it("pausing→paused only from pausing — the pause race has exactly one winner", async () => {
    const run = await newRun()

    // confirmPause on a RUNNING run must refuse (the executor may only
    // acknowledge a pause a user actually requested).
    const early = await confirmPause(db, run.id)
    expect(early).toEqual({ status: "invalid_state", current: "running" })

    const requested = await requestPause(db, run.id)
    expect(requested.status).toBe("ok")

    // Racing double-request: the second pause finds 'pausing', not 'running'.
    const second = await requestPause(db, run.id)
    expect(second).toEqual({ status: "invalid_state", current: "pausing" })

    const confirmed = await confirmPause(db, run.id)
    expect(confirmed.status).toBe("ok")
    if (confirmed.status === "ok") expect(confirmed.run.status).toBe("paused")

    // And the executor cannot double-confirm.
    expect((await confirmPause(db, run.id)).status).toBe("invalid_state")
  })

  it("resume works from paused AND parked; terminate is terminal; failed records the error", async () => {
    const run = await newRun()
    await requestPause(db, run.id)
    await confirmPause(db, run.id)
    const resumed = await resumeRun(db, run.id)
    expect(resumed.status).toBe("ok")

    const parked = await parkRun(db, run.id)
    expect(parked.status).toBe("ok")
    const woken = await resumeRun(db, run.id)
    expect(woken.status).toBe("ok")

    const failed = await failRun(db, run.id, "llm exploded")
    expect(failed.status).toBe("ok")
    expect((await getRun(db, run.id))?.lastError).toBe("llm exploded")

    // failed is terminal: no resume, no terminate, no pause.
    expect((await resumeRun(db, run.id)).status).toBe("invalid_state")
    expect((await terminateRun(db, run.id)).status).toBe("invalid_state")
    expect((await requestPause(db, run.id)).status).toBe("invalid_state")

    expect((await resumeRun(db, "no-such-run")).status).toBe("not_found")
  })
})

describe("span cursor + outcome accounting", () => {
  it("recordSpanOutcome advances the cursor and counters in one batch", async () => {
    const run = await newRun()
    const cursor: SpanCursor = { seeds: [seed(1), seed(3)], nextIndex: 0 }
    const set = await setSpanCursor(db, run.id, cursor)
    expect(set?.totalSpans).toBe(2)
    expect(set?.spanCursor?.nextIndex).toBe(0)

    const afterDone = await recordSpanOutcome(db, run.id, {
      cursor: { ...cursor, nextIndex: 1 },
      outcome: "done",
      unitsUsed: 12,
      callsUsed: 4,
      steeringCursor: new Date().toISOString(),
    })
    expect(afterDone?.doneSpans).toBe(1)
    expect(afterDone?.failedSpans).toBe(0)
    expect(afterDone?.unitsSpent).toBe(12)
    expect(afterDone?.callsSpent).toBe(4)
    expect(afterDone?.spanCursor?.nextIndex).toBe(1)
    expect(afterDone?.steeringCursor).not.toBeNull()

    const afterFail = await recordSpanOutcome(db, run.id, {
      cursor: { ...cursor, nextIndex: 2 },
      outcome: "failed",
      unitsUsed: 5,
      callsUsed: 1,
      lastError: "construal did not close",
    })
    expect(afterFail?.doneSpans).toBe(1)
    expect(afterFail?.failedSpans).toBe(1)
    expect(afterFail?.unitsSpent).toBe(17)
    expect(afterFail?.lastError).toBe("construal did not close")
  })
})

describe("steering inbox", () => {
  it("append → read-unconsumed (scoped) → markConsumed", async () => {
    const run = await newRun()
    const projWide = await appendSteering(db, { projectId: PROJECT, kind: "direction", body: "keep it plain" })
    const fileScoped = await appendSteering(db, { projectId: PROJECT, fileId: FILE, kind: "note", body: "fyi" })
    const otherFile = await appendSteering(db, { projectId: PROJECT, fileId: "file-other", kind: "direction", body: "not for us" })
    const otherRun = await appendSteering(db, { projectId: PROJECT, runId: "some-other-run", kind: "direction", body: "not our run" })
    expect([projWide.status, fileScoped.status, otherFile.status, otherRun.status]).toEqual(["ok", "ok", "ok", "ok"])

    const visible = await readUnconsumedSteering(db, { projectId: PROJECT, fileId: FILE, runId: run.id })
    expect(visible.map((s) => s.body)).toEqual(["keep it plain", "fyi"])

    await markSteeringConsumed(db, visible.map((s) => s.id))
    expect(await readUnconsumedSteering(db, { projectId: PROJECT, fileId: FILE, runId: run.id })).toEqual([])
    // The other-file entry stays unconsumed for ITS run.
    const others = await readUnconsumedSteering(db, { projectId: PROJECT, fileId: "file-other", runId: run.id })
    expect(others.map((s) => s.body)).toEqual(["not for us"])
  })

  it("enforces the 10KB body cap and the secret scan", async () => {
    const big = await appendSteering(db, { projectId: PROJECT, kind: "direction", body: "x".repeat(STEERING_MAX_BYTES + 1) })
    expect(big.status).toBe("validation_failed")
    const secret = await appendSteering(db, { projectId: PROJECT, kind: "direction", body: "use token=aqk_abc123" })
    expect(secret.status).toBe("validation_failed")
    const empty = await appendSteering(db, { projectId: PROJECT, kind: "note", body: "   " })
    expect(empty.status).toBe("validation_failed")
  })
})

describe("staged drafts", () => {
  it("a re-propose supersedes the old proposed row in the same batch (partial UNIQUE holds)", async () => {
    const run = await newRun()
    const first = await insertDrafts(db, {
      runId: run.id,
      projectId: PROJECT,
      fileId: FILE,
      sceneBriefId: "sb-1",
      drafts: [
        { cellId: "c1", text: "draft v1 of c1" },
        { cellId: "c2", text: "draft v1 of c2" },
      ],
    })
    expect(first).toHaveLength(2)

    // Re-propose c1 only (e.g. a refresh_span re-run of the same span).
    const second = await insertDrafts(db, {
      runId: run.id,
      projectId: PROJECT,
      fileId: FILE,
      sceneBriefId: "sb-2",
      drafts: [{ cellId: "c1", text: "draft v2 of c1" }],
    })
    expect(second).toHaveLength(1)
    expect(second[0].text).toBe("draft v2 of c1")

    const all = await listDrafts(db, PROJECT, FILE)
    const byStatus = (s: string) => all.filter((d) => d.status === s)
    expect(byStatus("proposed").map((d) => d.text).sort()).toEqual(["draft v1 of c2", "draft v2 of c1"])
    expect(byStatus("superseded").map((d) => d.text)).toEqual(["draft v1 of c1"])

    const counts = await countDrafts(db, PROJECT, FILE)
    expect(counts).toEqual({ proposed: 2, applied: 0, rejected: 0, superseded: 1 })
  })

  it("review transitions: only proposed rows; applied/rejected are terminal", async () => {
    const run = await newRun()
    const [draft] = await insertDrafts(db, {
      runId: run.id,
      projectId: PROJECT,
      fileId: FILE,
      drafts: [{ cellId: "c9", text: "review me" }],
    })

    const applied = await reviewDraft(db, { id: draft.id, action: "applied", reviewedBy: "lead" })
    expect(applied.status).toBe("ok")
    if (applied.status === "ok") {
      expect(applied.draft.status).toBe("applied")
      expect(applied.draft.reviewedBy).toBe("lead")
      expect(applied.draft.reviewedAt).not.toBeNull()
    }

    // Double review loses the guard.
    const again = await reviewDraft(db, { id: draft.id, action: "rejected" })
    expect(again).toEqual({ status: "invalid_state", current: "applied" })
    expect((await reviewDraft(db, { id: "no-such", action: "applied" })).status).toBe("not_found")
  })
})
